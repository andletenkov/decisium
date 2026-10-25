// Step execution (task 0051): one Gherkin Step from text to Step outcome, without cucumber. steps.ts adapts it.
import { UiChanged, type Cassette } from "./cassette.ts";
import type { Decider } from "./decision.ts";
import { jevUsage } from "./jev.ts";
import { runAssertion, runStep, type Runtime, type StepResult } from "./runner.ts";
import { readStep, type StepArgument, type StepKind } from "./step.ts";

export interface StepContext {
  rt: Runtime;
  live: Decider;
  cassette?: Cassette;
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
  seconds: number;
  jevCalls: number;
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
    before = { ...jevUsage };
  const { table, docString } = arg;
  const perRow = !!table && kind !== "assertion";
  const { rows } = readStep({ text, kind, ...arg });
  // A header row alone (an action table with 3+ columns) leaves no row to act on; otherwise the rows decide.
  let r: StepResult = rows.length
    ? { outcome: "DONE" }
    : { outcome: "AMBIGUOUS", reason: "the table has only its header row, so there is no row to act on" };
  const served: StepReport["cassette"][] = [];
  for (const [i, row] of rows.entries()) {
    const entry = cassette?.step(perRow ? `${key} (row ${i + 1})` : key, live, log);
    const decider = trace(entry ?? live);
    try {
      r =
        kind === "assertion"
          ? await runAssertion(text, rt, decider, log, !!ctx.judged, { ...earlier }, arg)
          : await runStep(row, rt, decider, log, kind === "attempt", docString);
    } catch (err) {
      if (/max_tokens_exceeded/.test(String((err as Error)?.message))) {
        // The page, not the setup: fail this Step and let the rest of the feature run (task 0021).
        log(`  => PAGE_TOO_LARGE`);
        r = {
          outcome: "PAGE_TOO_LARGE",
          reason: "the page is too large for one Jev request, even reduced to the sections that matter",
        };
      } else if (err instanceof UiChanged) {
        log(`  => UI_CHANGED`);
        r = { outcome: "UI_CHANGED", reason: err.reason };
      } else throw err;
    }
    served.push(entry?.done(!["UI_CHANGED", "PAGE_TOO_LARGE"].includes(r.outcome)));
    if (r.outcome !== "DONE" && perRow) r = { ...r, reason: `row ${i + 1} (${row})${r.reason ? `: ${r.reason}` : ""}` };
    if (r.outcome !== "DONE") break;
  }
  if (r.marginal && ctx.strict)
    r = { outcome: "AMBIGUOUS", reason: `passed, but Jev was barely confident (--strict): ${r.marginal}` };
  for (const row of rows) for (const v of readStep({ text: row, kind }).quoted) earlier[v] = row;
  // Cost and time per Step: live Jev calls and tokens (cassette replays cost 0), wall-clock seconds.
  return {
    ...r,
    cassette: served.find((c) => c !== "replayed") ?? served[0],
    seconds: (Date.now() - start) / 1000,
    jevCalls: jevUsage.calls - before.calls,
    inputTokens: jevUsage.inputTokens - before.inputTokens,
    outputTokens: jevUsage.outputTokens - before.outputTokens,
  };
}
