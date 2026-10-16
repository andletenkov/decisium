import type { Action } from "./browser.ts";
import { gate, GATE_TOP, PAGE_ACTIONS, STATES, type Assessment, type Decider, type Pick } from "./jev.ts";
import { assertableText, MASK, quoted, stepValues, type Element, type Observation } from "./observation.ts";

export type StepOutcome =
  | "DONE" | "BLOCKED" | "AMBIGUOUS" | "ELEMENT_NOT_FOUND" | "ACTION_FAILED" | "STEP_TIMEOUT" // Action steps
  | "PASSED" | "ASSERTION_FAILED" | "UNVERIFIABLE" // Assertion steps (AMBIGUOUS too)
  | "JUDGED_PASSED" | "JUDGED_FAILED"; // opt-in fuzzy Assertion steps

export interface Runtime {
  observe(): Promise<Observation>;
  execute(action: Action): Promise<void>;
  /** Resolves true once the Observation differs from `since`, false on timeout. */
  waitForChange(since: string, timeoutMs?: number): Promise<boolean>;
}

export interface StepResult {
  outcome: StepOutcome;
  reason?: string;
}

const MAX_TURNS = 8;
const ASSERT_TIMEOUT_MS = 5000; // total time an Assertion step may wait for the UI to reach the expected state
const DONE_THRESHOLD = 0.8;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case/space-insensitive containment: "1 week" must not match "11 weeks". */
export const containsValue = (actual: string, expected: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(norm(expected))}(?![\\p{L}\\p{N}])`, "u").test(norm(actual));

const STATE_FLAG: Record<keyof typeof STATES, [flag: string, on: boolean]> = {
  disabled: ["disabled", true], enabled: ["disabled", false],
  checked: ["checked", true], unchecked: ["checked", false],
  expanded: ["expanded", true], collapsed: ["expanded", false],
  selected: ["selected", true], unselected: ["selected", false],
  pressed: ["pressed", true], unpressed: ["pressed", false],
};
const JUDGED_THRESHOLD = 0.8;

/**
 * Jev classifies the check and picks the element it is about; code decides pass/fail.
 * `judged` opts in to fuzzy checks, which Jev answers directly and are reported as JUDGED_*, never PASSED.
 */
export async function runAssertion(step: string, rt: Runtime, decider: Decider, log = console.log, judged = false): Promise<StepResult> {
  log(`\nAssert: ${step}`);
  const end = finish(log);
  const values = quoted(step);

  // Like Playwright's expect: a check that does not pass is re-evaluated whenever the UI changes, until
  // the UI stops changing within the wait cap. Jev is asked again only after a change.
  const deadline = Date.now() + ASSERT_TIMEOUT_MS;
  let obs = await rt.observe();
  for (;;) {
    const verdict = await check(obs);
    const final = ["PASSED", "JUDGED_PASSED", "UNVERIFIABLE"].includes(verdict.outcome);
    const left = deadline - Date.now();
    if (final || left <= 0) return end(verdict.outcome, verdict.reason);
    log("  (not passed yet; waiting for the UI to change)");
    if (!(await rt.waitForChange(obs.text, left))) return end(verdict.outcome, verdict.reason);
    obs = await rt.observe();
  }

  async function check(obs: Observation): Promise<Verdict> {
    const mentioned = values.length ? obs.readable.filter(e => values.every(v => containsValue(`${e.name} ${e.value}`, v))) : [];
    const a = await decider.assess(step, obs, judged, mentioned);
    log(`  Kind: ${fmt(a.kind)}`);
    // Gate on the result, not the label: evaluate every plausible kind (most likely first, until they
    // cover the gate's confidence) and accept only if they all reach the same outcome.
    const plausible: string[] = [];
    let covered = 0;
    for (const [kind, p] of Object.entries(a.kind.probabilities).sort((x, y) => y[1] - x[1])) {
      if (covered >= GATE_TOP) break;
      plausible.push(kind);
      covered += p;
    }
    const results = plausible.map(kind => ({ kind, ...evaluate(kind, a, obs, values, mentioned, log) }));
    const first = results[0];
    if (results.every(r => r.outcome === first.outcome)) return first;
    return { outcome: "AMBIGUOUS", reason: `plausible kinds disagree: ${results.map(r => `${r.kind}->${r.outcome}`).join(", ")}` };
  }
}

type Verdict = { outcome: StepOutcome; reason?: string };

/** Pass/fail for one kind of check, decided by code from the elements Jev identified. */
function evaluate(kind: string, a: Assessment, obs: Observation, values: string[], mentioned: Element[], log: typeof console.log): Verdict {
  if (kind === "fuzzy") {
    if (a.judged === undefined) return { outcome: "UNVERIFIABLE", reason: "fuzzy check; rerun with --judged to let Jev judge it" };
    log(`  Judged: p=${a.judged.toFixed(2)}`);
    if (a.judged >= JUDGED_THRESHOLD) return { outcome: "JUDGED_PASSED", reason: `p=${a.judged.toFixed(2)}` };
    if (a.judged <= 1 - JUDGED_THRESHOLD) return { outcome: "JUDGED_FAILED", reason: `p=${a.judged.toFixed(2)}` };
    return { outcome: "AMBIGUOUS", reason: `judgement unclear (p=${a.judged.toFixed(2)})` };
  }

  if (kind === "presence" || kind === "absence") {
    if (!values.length) return { outcome: "UNVERIFIABLE", reason: "a presence check needs a quoted value" };
    // No element even contains the quoted text: decided by code alone. Otherwise Jev says whether one of
    // those elements is the thing itself (not, say, a message that mentions it).
    let found = false;
    if (mentioned.length && a.holder) {
      log(`  Holder: ${fmt(a.holder)}`);
      if (!gate(a.holder)) return { outcome: "AMBIGUOUS", reason: `holder unclear (${fmt(a.holder)})` };
      found = a.holder.choice !== "none";
    }
    const pass = found === (kind === "presence");
    return pass ? { outcome: "PASSED" } : { outcome: "ASSERTION_FAILED", reason: found ? `found ${a.holder!.choice}, expected none` : "no matching element" };
  }

  if (kind === "state") {
    log(`  Subject: ${fmt(a.subject)}  State: ${fmt(a.state)}`);
    if (!gate(a.subject) || !gate(a.state)) return { outcome: "AMBIGUOUS", reason: `subject or state unclear (${fmt(a.subject)} | ${fmt(a.state)})` };
    if (a.subject.choice === "none") return { outcome: "ASSERTION_FAILED", reason: "no matching element" };
    const el = obs.readable.find(e => e.ref === a.subject.choice);
    if (!el) return { outcome: "ELEMENT_NOT_FOUND", reason: `ref ${a.subject.choice} not in observation` };
    const [flag, on] = STATE_FLAG[a.state.choice as keyof typeof STATES];
    const has = el.state.split(/\s+/).includes(`[${flag}]`);
    log(`  Compare: ${flag}=${has}, expected ${on}`);
    return has === on ? { outcome: "PASSED" } : { outcome: "ASSERTION_FAILED", reason: `expected ${a.state.choice}, ${el.line}` };
  }

  // kind === "value"
  if (values.length !== 1) return { outcome: "UNVERIFIABLE", reason: "a value check needs exactly one quoted expected value" };
  log(`  Subject: ${fmt(a.subject)}`);
  if (!gate(a.subject)) return { outcome: "AMBIGUOUS", reason: `subject unclear (${fmt(a.subject)})` };
  if (a.subject.choice === "none") return { outcome: "ASSERTION_FAILED", reason: "no element shows the checked state" };
  const el = obs.readable.find(e => e.ref === a.subject.choice);
  if (!el) return { outcome: "ELEMENT_NOT_FOUND", reason: `ref ${a.subject.choice} not in observation` };
  const actual = assertableText(el);
  if (actual === undefined) return { outcome: "UNVERIFIABLE", reason: `${el.line} has no text to compare` };
  log(`  Compare: "${values[0]}" in "${actual}"`);
  return containsValue(actual, values[0])
    ? { outcome: "PASSED" }
    : { outcome: "ASSERTION_FAILED", reason: `expected "${values[0]}", found "${actual}" in ${el.line}` };
}

const finish = (log: typeof console.log) => (outcome: StepOutcome, reason?: string): StepResult => {
  log(`  => ${outcome}${reason ? `: ${reason}` : ""}`);
  return { outcome, reason };
};

const fmt = (p: Pick) =>
  Object.entries(p.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");

export async function runStep(step: string, rt: Runtime, decider: Decider, log = console.log): Promise<StepResult> {
  log(`\nStep: ${step}`);
  const end = finish(log);
  const recent: string[] = []; // this Step's actions, sent to Jev so it knows what it already did
  let unchanged = 0;
  let obs = await rt.observe();

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    log(`\n  Observation #${turn}:`);
    for (const e of obs.elements) log(`    [${e.ref}] ${e.line}`);

    const t = await decider.turn(step, obs, recent);
    log(`  Decision: done=${t.done.toFixed(2)} target: ${fmt(t.target)}`);
    if (t.done >= DONE_THRESHOLD) return end("DONE");
    if (!gate(t.target)) return end("AMBIGUOUS", `target unclear (${fmt(t.target)})`);
    if (t.target.choice === "none") return end("BLOCKED", "no element helps accomplish the step");

    let action: Action;
    let described: string;
    if (t.target.choice in PAGE_ACTIONS) {
      action = { verb: t.target.choice === "scroll" ? "SCROLL" : "WAIT" };
      described = action.verb;
    } else {
      const el = obs.elements.find(e => e.ref === t.target.choice);
      if (!el) return end("ELEMENT_NOT_FOUND", `ref ${t.target.choice} not in observation`);
      action = { verb: el.verb, ref: el.ref };
      if (el.verb !== "CLICK") {
        const candidates = el.verb === "SELECT" ? el.options : stepValues(step);
        if (!candidates.length) return end("AMBIGUOUS", `no candidate value for ${el.line}`);
        const v = await decider.value(step, obs, el, candidates);
        log(`  Value: ${el.secret ? "(secret)" : fmt(v)}`);
        if (!gate(v) || v.choice === "none") return end("AMBIGUOUS", "value unclear");
        action.value = v.choice;
      }
      const shown = action.value === undefined ? "" : ` <- "${el.secret ? MASK : action.value}"`;
      described = `${action.verb} ${el.role} "${el.name}"${shown}`;
    }
    log(`  Execute: ${described}`);
    try {
      await rt.execute(action);
    } catch (err) {
      return end("ACTION_FAILED", (err as Error).message.split("\n")[0]);
    }
    recent.push(described);

    const next = await rt.observe();
    unchanged = next.text === obs.text ? unchanged + 1 : 0;
    if (unchanged >= 2) return end("BLOCKED", "UI did not change after two actions");
    obs = next;
  }
  return end("STEP_TIMEOUT", `not done after ${MAX_TURNS} turns`);
}
