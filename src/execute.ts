// Step execution (task 0051): one Gherkin Step from text to Step outcome, without cucumber. steps.ts adapts it.
import { UiChanged, type Cassette } from "./cassette.ts";
import type { Decider } from "./decision.ts";
import { modelUsage } from "./model-decider.ts";
import { settings } from "./options.ts";
import type { DecisionMetadata } from "./decision-provider.ts";
import { runAssertion, runStep, type Runtime, type StepResult } from "./runner.ts";
import { readStep, type StepArgument, type StepKind } from "./step.ts";

/** The outcomes of a Step that reached its goal: the only answers a cassette keeps. */
const SUCCESS = new Set(["DONE", "PASSED"]);
/** Outcomes whose answers would only fail the same way when replayed: never written, not even for a new Step. */
const USELESS = new Set(["AMBIGUOUS", "UI_CHANGED", "PAGE_TOO_LARGE"]);

export interface StepContext {
  rt: Runtime;
  live: Decider;
  cassette?: Cassette;
  generated?: Record<string, string>;
  /** The Step's cassette key (stepKey); a table row adds ` (row n)`. */
  key: string;
  kind: StepKind;
  arg: StepArgument;
  /** Scenario memory: quoted value -> the Step that named it. This Step's values are added once it ends. */
  earlier: Record<string, string>;
  log: (line: string) => void;
  /** Wraps each Decider the Step uses (the run's trace). */
  trace?: (d: Decider) => Decider;
  judged?: boolean;
  /** A Marginal pass fails as AMBIGUOUS. */
  strict?: boolean;
}

export interface StepReport extends StepResult {
  /** How the Cassette served the Step; undefined without one, or when nothing was kept. */
  cassette?: "replayed" | "recorded" | "healed";
  /** Elements the Step acted on that only a position among identical twins identifies: the Step should name which. */
  positional?: string[];
  seconds: number;
  jevCalls: number;
  decisions?: DecisionMetadata[];
  usageUnavailable?: boolean;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Runs one Step: an Action step's Data table as one Step per row (the first that is not DONE stops it), each with its
 * own Cassette entry. A page too large for Jev and a broken replay are Step outcomes; any other error is thrown (setup).
 */
export async function executeStep(text: string, ctx: StepContext): Promise<StepReport> {
  const { rt, live, cassette, key, kind, arg, earlier, log, trace = (d) => d } = ctx;
  const start = Date.now(),
    before = { ...modelUsage };
  const decisionStart = live.decisions?.length ?? 0;
  const { table, docString } = arg;
  const perRow = !!table && kind !== "assertion";
  const { rows } = readStep({ text, kind, ...arg });
  // A header row alone (an action table with 3+ columns) leaves no row to act on; otherwise the rows decide.
  let r: StepResult = rows.length
    ? { outcome: "DONE" }
    : { outcome: "AMBIGUOUS", reason: "the table has only its header row, so there is no row to act on" };
  const served: StepReport["cassette"][] = [];
  const positional: string[] = [];
  const unquoted: [string, string][] = []; // values Jev read without quotes: scenario memory too
  for (const [i, row] of rows.entries()) {
    const rowKey = perRow ? `${key} (row ${i + 1})` : key;
    let entry = cassette?.step(rowKey, live, log, ctx.generated);
    const deadline = Date.now() + settings().checkTimeout;
    r = await attempt(row, entry, deadline);
    // A replayed check that does not pass may rest on a recording that no longer fits the page: Jev is asked once
    // more before it fails (issue #90). A check only reads the page, so running it again repeats nothing.
    if (kind === "assertion" && !SUCCESS.has(r.outcome) && cassette?.canAsk && entry?.replaying()) {
      log("  (cassette: the replayed check did not pass, asking Jev again)");
      entry = cassette.step(rowKey, live, log, ctx.generated, true);
      r = await attempt(row, entry, deadline); // the time the replay already waited counts: a failure waits once
    }
    // A new Step keeps any answer Jev was sure of (a real ASSERTION_FAILED replays as one); a heal replaces the
    // recording only with one that reached the Step's goal (issue #90).
    served.push(entry?.done(!USELESS.has(r.outcome), SUCCESS.has(r.outcome)));
    positional.push(...(entry?.positional() ?? []));
    if (r.outcome === "AMBIGUOUS" && r.reason?.startsWith("Jev is unsure what to do next:")) {
      const resolutions = cassette?.resolutions(rowKey, { text: row, kind, ...arg }) ?? [];
      if (resolutions.length) r.reason += `\nResolutions (confirm the final action target):\n${resolutions.join("\n")}`;
    }
    if (r.outcome !== "DONE" && perRow) r = { ...r, reason: `row ${i + 1} (${row})${r.reason ? `: ${r.reason}` : ""}` };
    if (r.outcome !== "DONE") break;
  }

  async function attempt(row: string, entry: Decider | undefined, deadline: number): Promise<StepResult> {
    const decider = trace(entry ?? live);
    try {
      // How Jev reads the wording (issue #31); DECISIUM_NO_INTENT=1 keeps the wording rules alone (A/B runs).
      const intent = process.env.DECISIUM_NO_INTENT === "1" ? {} : await decider.intent?.(row, kind === "assertion");
      if (intent && Object.keys(intent).length) log(`  Intent: ${JSON.stringify(intent)}`);
      if (intent?.value && kind !== "assertion") unquoted.push([intent.value, row]);
      return kind === "assertion"
        ? await runAssertion(text, rt, decider, log, !!ctx.judged, { ...earlier }, arg, intent, deadline)
        : await runStep(row, rt, decider, log, kind === "attempt", docString, intent);
    } catch (err) {
      if (/max_tokens_exceeded/.test(String((err as Error)?.message))) {
        // The page, not the setup: fail this Step and let the rest of the feature run (task 0021).
        log(`  => PAGE_TOO_LARGE`);
        return {
          outcome: "PAGE_TOO_LARGE",
          reason: "the page is too large for one Jev request, even reduced to the sections that matter",
        };
      } else if (err instanceof UiChanged) {
        log(`  => UI_CHANGED`);
        return { outcome: "UI_CHANGED", reason: err.reason };
      }
      throw err;
    }
  }
  if (r.marginal && ctx.strict)
    r = { outcome: "AMBIGUOUS", reason: `passed, but Jev was barely confident (--strict): ${r.marginal}` };
  for (const row of rows) for (const v of readStep({ text: row, kind }).quoted) earlier[v] = row;
  for (const [v, row] of unquoted) earlier[v] ??= row;
  // Cost and time per Step: live Jev calls and tokens (cassette replays cost 0), wall-clock seconds.
  return {
    ...r,
    cassette: served.find((c) => c !== "replayed") ?? served[0],
    ...(positional.length ? { positional } : {}),
    seconds: (Date.now() - start) / 1000,
    jevCalls: modelUsage.calls - before.calls,
    inputTokens: modelUsage.inputTokens - before.inputTokens,
    outputTokens: modelUsage.outputTokens - before.outputTokens,
    ...(modelUsage.unavailable > before.unavailable ? { usageUnavailable: true } : {}),
    ...(live.decisions?.length ? { decisions: live.decisions.slice(decisionStart) } : {}),
  };
}
