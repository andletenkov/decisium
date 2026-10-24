import type { Action } from "./browser.ts";
import { readStep, type StepArgument } from "./step.ts";
import { gate, GATE_TARGET_MARGIN, GATE_TARGET_TOP, NotYet, pageActions, named, fmt, type Decider, type Pick, type TurnAnswer } from "./decision.ts";
import { verdict as checkVerdict, type Verdict } from "./check.ts";
import { MASK, type Dialog, type Observation } from "./observation.ts";

export type StepOutcome =
  | "DONE" | "BLOCKED" | "AMBIGUOUS" | "ELEMENT_NOT_FOUND" | "ACTION_FAILED" | "STEP_TIMEOUT" // Action steps
  | "PASSED" | "ASSERTION_FAILED" | "UNVERIFIABLE" // Assertion steps (AMBIGUOUS too)
  | "JUDGED_PASSED" | "JUDGED_FAILED" // opt-in fuzzy Assertion steps
  | "UI_CHANGED" | "PAGE_TOO_LARGE"; // either kind: a replay-only Resolution broke, the page is over Jev's request limit

export interface Runtime {
  observe(): Promise<Observation>;
  execute(action: Action): Promise<void>;
  /** Resolves true once the Observation differs from `since`, false on timeout. */
  waitForChange(since: string, timeoutMs?: number): Promise<boolean>;
  /** Runs one Action step with runtime-owned setup and cleanup, even if it throws. */
  actionStep<T>(run: () => Promise<T>, log: typeof console.log): Promise<T>;
}

export interface StepResult {
  outcome: StepOutcome;
  reason?: string;
  /** PASSED resting on a barely-confident Jev answer: which answers, for the warning (task 0027). */
  marginal?: string;
}

/** `ask` on `obs`, re-observing after each change while it throws NotYet. */
async function settled<T>(rt: Runtime, obs: Observation, ask: (obs: Observation) => Promise<T>): Promise<[Observation, T]> {
  const deadline = Date.now() + ASSERT_TIMEOUT_MS;
  for (;;) {
    try { return [obs, await ask(obs)]; } catch (err) {
      if (!(err instanceof NotYet)) throw err;
      const left = deadline - Date.now();
      if (left <= 0 || !(await rt.waitForChange(obs.text, left))) throw err.final;
      obs = await rt.observe();
    }
  }
}

const MAX_TURNS = 8;

const TOGGLES = new Set(["checkbox", "switch", "menuitemcheckbox"]);
/** Jev torn between "nothing to do" and a toggle already in the wanted state (task 0043): both mean done. */
function alreadyToggled(pick: Pick, obs: Observation, goal: boolean | undefined): boolean {
  const done = (c: string) => c === "none" || obs.elements.some(e => e.ref === c && toggled(e, goal));
  if (!Object.entries(pick.probabilities).some(([c, p]) => c !== "none" && p >= 0.1 && done(c))) return false;
  const merged: Record<string, number> = {};
  for (const [c, p] of Object.entries(pick.probabilities)) merged[done(c) ? "none" : c] = (merged[done(c) ? "none" : c] ?? 0) + p;
  return gate({ choice: "none", probabilities: merged }, GATE_TARGET_TOP, GATE_TARGET_MARGIN)
    && Object.entries(merged).every(([c, p]) => c === "none" || p < merged.none);
}

/** The element is a toggle in the Step's wanted state, or a checked radio (radios cannot be unchecked). */
const toggled = (e: { role: string; state: string }, goal: boolean | undefined) => goal !== undefined
  && (TOGGLES.has(e.role) || e.role === "radio" && goal) && /\[checked\]/.test(e.state) === goal;
const PAGE_VERBS: Record<string, Action["verb"]> = { scroll: "SCROLL", wait: "WAIT", enter: "ENTER", back: "BACK", forward: "FORWARD",
  reload: "RELOAD", "close tab": "CLOSE_TAB", "switch tab": "SWITCH_TAB" };
const ASSERT_TIMEOUT_MS = 5000; // total time an Assertion step may wait for the UI to reach the expected state
const DONE_THRESHOLD = 0.8;
const HOVER_THRESHOLD = 0.5; // Jev's `hover` answer: above it the chosen element is hovered instead of its own verb (task 0042)
/**
 * After an action that changed the page, "nothing left to do" is evidence too: with it, done needs only this much
 * (task 0007). In the corpus every such Turn with done >= 0.5 was a real success (SauceDemo cart 0.58-0.77).
 */
const DONE_AFTER_ACTION = 0.5;

/**
 * Jev classifies the check and picks the element it is about; code decides pass/fail.
 * `judged` opts in to fuzzy checks, which Jev answers directly and are reported as JUDGED_*, never PASSED.
 */
/**
 * `earlier`: quoted values from this scenario's earlier Steps (value -> Step), for checks that quote none.
 * `arg`: a doc string is one more quoted value; a one-column table is a list of values that must all be shown, a wider
 * one is matched row by row to the page table under its column headers.
 */
export async function runAssertion(step: string, rt: Runtime, decider: Decider, log = console.log, judged = false, earlier: Record<string, string> = {}, arg: StepArgument = {}): Promise<StepResult> {
  const { label: said, values, list, exact } = readStep({ text: step, kind: "assertion", ...arg }); // said: what Jev reads, with the table or doc string
  log(`\nAssert: ${said}`);
  const end = finish(log);
  const { table } = arg;
  if (table && !list && table.length < 2) return end("UNVERIFIABLE", "the table has only its header row (a check's first row names the columns), so there is no row to compare");
  let recallNote = "";
  let recall: Pick | undefined;
  if (!values.length && !table && Object.keys(earlier).length) {
    const r = await decider.recall(said, earlier);
    log(`  Recall: ${fmt(r)}`);
    if (gate(r) && r.choice !== "none") { values.push(r.choice); recall = r; }
    else recallNote = `; Jev could not tell which earlier value it refers to (${named(r)})`;
  }

  // Like Playwright's expect: a check that does not pass is re-evaluated whenever the UI changes, until
  // the UI stops changing within the wait cap. Jev is asked again only after a change.
  const deadline = Date.now() + ASSERT_TIMEOUT_MS;
  let obs = await rt.observe();
  for (;;) {
    let verdict: Verdict;
    [obs, verdict] = await settled(rt, obs, check);
    const final = ["PASSED", "JUDGED_PASSED", "UNVERIFIABLE"].includes(verdict.outcome);
    const left = deadline - Date.now();
    if (verdict.outcome === "UNVERIFIABLE") verdict.reason += recallNote;
    if (final || left <= 0) return end(verdict.outcome, verdict.reason, verdict.marginal);
    log("  (not passed yet; waiting for the UI to change)");
    if (!(await rt.waitForChange(obs.text, left))) return end(verdict.outcome, verdict.reason);
    obs = await rt.observe();
  }

  async function check(obs: Observation): Promise<Verdict> {
    const a = await decider.assess(said, obs, judged);
    const result = checkVerdict(a, obs, { values, table, list, exact, recall });
    for (const line of result.details) log(line);
    return result;
  }
}

const finish = (log: typeof console.log) => (outcome: StepOutcome, reason?: string, weak: string[] = []): StepResult => {
  const marginal = weak.length ? weak.join("; ") : undefined;
  log(`  => ${outcome}${reason ? `: ${reason}` : ""}${marginal ? ` (marginal: ${marginal})` : ""}`);
  return { outcome, reason, ...(marginal ? { marginal } : {}) };
};

/**
 * Action or Attempt step. An Attempt is done once its actions are performed, even if the app rejects them.
 * `docString`: one more value to type, read by Jev with the Step.
 */
export async function runStep(step: string, rt: Runtime, decider: Decider, log = console.log, attempt = false, docString?: string): Promise<StepResult> {
  return rt.actionStep(() => act(step, rt, decider, log, attempt, docString), log);
}

/**
 * How to answer the open dialog: Cancel unless Jev is sure the Step means OK (or one of its quoted values, for a
 * prompt). An alert, or a prompt the Step quotes nothing for, has no other answer, so Jev is not asked.
 */
async function answerDialog(dialog: Dialog, said: string, values: string[], obs: Observation, decider: Decider, log: typeof console.log): Promise<Action> {
  const answers = dialog.type === "alert" ? [] : dialog.type === "prompt" ? values : ["accept"];
  if (!answers.length) return { verb: "DISMISS" };
  const p = await decider.dialog(said, obs, [...answers, "dismiss"]);
  log(`  Dialog answer: ${fmt(p)}`);
  if (!gate(p) || p.choice === "dismiss") return { verb: "DISMISS" };
  return dialog.type === "prompt" ? { verb: "ACCEPT", value: p.choice } : { verb: "ACCEPT" };
}

async function act(step: string, rt: Runtime, decider: Decider, log: typeof console.log, attempt: boolean, docString?: string): Promise<StepResult> {
  const read = readStep({ text: step, kind: "action", docString });
  const said = read.label;
  log(`\n${attempt ? "Attempt" : "Step"}: ${said}`);
  const end = finish(log);
  // Only "press X" or "go back" / "go to /x": nothing to choose, so code does it and the following checks verify the
  // effect (tasks 0039, 0041).
  const only: Action | undefined = read.pressOnly ? { verb: "PRESS", value: read.pressOnly } : read.navigation;
  if (only) {
    const described = `${only.verb}${only.value === undefined ? "" : ` ${only.value}`}`;
    log(`  Execute: ${described}`);
    try {
      await rt.execute(only);
    } catch (err) {
      return end("ACTION_FAILED", `${described} failed: ${(err as Error).message.split("\n")[0]}`);
    }
    return end("DONE");
  }
  const recent: string[] = []; // this Step's actions, sent to Jev so it knows what it already did
  let unchanged = 0;
  let obs = await rt.observe();

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    log(`\n  Observation #${turn}:`);
    for (const e of obs.elements) log(`    [${e.ref}] ${e.line}`);

    // An open dialog blocks the page: this Turn answers it, nothing else.
    if (obs.dialog?.state === "open") {
      const action = await answerDialog(obs.dialog, said, read.values, obs, decider, log);
      const described = `${action.verb} ${obs.dialog.type} "${obs.dialog.message}"${action.value === undefined ? "" : ` <- "${action.value}"`}`;
      log(`  Execute: ${described}`);
      try {
        await rt.execute(action);
      } catch (err) {
        return end("ACTION_FAILED", `${described} failed: ${(err as Error).message.split("\n")[0]}`);
      }
      recent.push(described);
      obs = await rt.observe();
      unchanged = 0;
      continue;
    }

    let t: TurnAnswer;
    [obs, t] = await settled(rt, obs, o => decider.turn(said, o, recent, attempt, read.keys));
    log(`  Decision: done=${t.done.toFixed(2)}${t.hover === undefined ? "" : ` hover=${t.hover.toFixed(2)}`} target: ${fmt(t.target)}`);
    if (t.done >= DONE_THRESHOLD) return end("DONE");
    if (recent.length && unchanged === 0 && t.target.choice === "none" && t.done >= DONE_AFTER_ACTION) return end("DONE");
    if (alreadyToggled(t.target, obs, read.toggle)) { log("  Toggle: already done"); return end("DONE"); }
    if (!gate(t.target, GATE_TARGET_TOP, GATE_TARGET_MARGIN)) return end("AMBIGUOUS", `Jev is unsure what to do next: ${named(t.target, obs)}`);
    if (t.target.choice === "none") return end("BLOCKED", "nothing on this screen helps do the step");

    let action: Action;
    let described: string;
    if (t.target.choice in pageActions(obs, read.keys)) {
      const key = /^press (.+)$/.exec(t.target.choice)?.[1];
      action = key ? { verb: "PRESS", value: key } : { verb: PAGE_VERBS[t.target.choice] };
      described = key ? `PRESS ${key}` : action.verb;
    } else {
      const el = obs.elements.find(e => e.ref === t.target.choice);
      if (!el) return end("ELEMENT_NOT_FOUND", `Jev chose an element that is no longer on the page (${t.target.choice})`);
      if (el.verb === "CLICK" && toggled(el, read.toggle)) { log(`  Toggle: already ${el.line}`); return end("DONE"); }
      action = { verb: (t.hover ?? 0) >= HOVER_THRESHOLD ? "HOVER" : el.verb, ref: el.ref };
      if (action.verb === "TYPE" || action.verb === "SELECT") {
        const candidates = el.verb === "SELECT" ? el.options : read.candidates;
        if (!candidates.length) return end("AMBIGUOUS", `the step gives no value to enter into ${el.line}; quote it (e.g. enter "Winter Sale")`);
        const v = await decider.value(said, obs, el, candidates);
        log(`  Value: ${el.secret ? "(secret)" : fmt(v)}`);
        if (!gate(v) || v.choice === "none") return end("AMBIGUOUS", `Jev is unsure which value to enter into ${el.line}${el.secret ? "" : `: ${named(v)}`}`);
        action.value = v.choice;
      }
      const shown = action.value === undefined ? "" : ` <- "${el.secret ? MASK : action.value}"`;
      described = `${action.verb} ${el.role} "${el.name}"${shown}`;
    }
    log(`  Execute: ${described}`);
    try {
      await rt.execute(action);
    } catch (err) {
      return end("ACTION_FAILED", `${described} failed: ${(err as Error).message.split("\n")[0]}`);
    }
    recent.push(described);

    const next = await rt.observe();
    const box = action.verb === "CLICK" ? next.elements.find(e => e.ref === action.ref && toggled(e, read.toggle)) : undefined;
    if (box) { log(`  Toggle: ${box.line}`); return end("DONE"); }
    unchanged = next.text === obs.text ? unchanged + 1 : 0;
    if (unchanged >= 2) return end("BLOCKED", `the page did not change after two actions (last: ${described})`);
    obs = next;
  }
  return end("STEP_TIMEOUT", `not done after ${MAX_TURNS} actions (${recent.join(", ")})`);
}
