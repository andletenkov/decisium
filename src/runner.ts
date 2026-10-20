import type { Action } from "./browser.ts";
import { AREA_MISSING, AREA_PAGE, gate, GATE_TOP, pageActions, STATES, type Assessment, type Decider, type Pick } from "./jev.ts";
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
const PAGE_VERBS: Record<string, Action["verb"]> = { scroll: "SCROLL", wait: "WAIT", enter: "ENTER" };
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
// Roles that can carry each ARIA state (WAI-ARIA 1.2). `disabled` applies to any control, so it has no entry.
const STATE_ROLES: Record<string, string[]> = {
  checked: ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio", "option", "treeitem"],
  selected: ["option", "tab", "row", "gridcell", "columnheader", "rowheader", "treeitem"],
  expanded: ["button", "combobox", "link", "menuitem", "tab", "treeitem", "row", "gridcell", "rowheader", "checkbox", "listbox", "application"],
  pressed: ["button"],
};
const JUDGED_THRESHOLD = 0.8;

/**
 * Jev classifies the check and picks the element it is about; code decides pass/fail.
 * `judged` opts in to fuzzy checks, which Jev answers directly and are reported as JUDGED_*, never PASSED.
 */
/** `earlier`: quoted values from this scenario's earlier Steps (value -> Step), for checks that quote none. */
export async function runAssertion(step: string, rt: Runtime, decider: Decider, log = console.log, judged = false, earlier: Record<string, string> = {}): Promise<StepResult> {
  log(`\nAssert: ${step}`);
  const end = finish(log);
  const values = quoted(step);
  let recallNote = "";
  if (!values.length && Object.keys(earlier).length) {
    const r = await decider.recall(step, earlier);
    log(`  Recall: ${fmt(r)}`);
    if (gate(r) && r.choice !== "none") values.push(r.choice);
    else recallNote = `; Jev could not tell which earlier value it refers to (${named(r)})`;
  }

  // Like Playwright's expect: a check that does not pass is re-evaluated whenever the UI changes, until
  // the UI stops changing within the wait cap. Jev is asked again only after a change.
  const deadline = Date.now() + ASSERT_TIMEOUT_MS;
  let obs = await rt.observe();
  for (;;) {
    const verdict = await check(obs);
    const final = ["PASSED", "JUDGED_PASSED", "UNVERIFIABLE"].includes(verdict.outcome);
    const left = deadline - Date.now();
    if (verdict.outcome === "UNVERIFIABLE") verdict.reason += recallNote;
    if (final || left <= 0) return end(verdict.outcome, verdict.reason);
    log("  (not passed yet; waiting for the UI to change)");
    if (!(await rt.waitForChange(obs.text, left))) return end(verdict.outcome, verdict.reason);
    obs = await rt.observe();
  }

  async function check(obs: Observation): Promise<Verdict> {
    const a = await decider.assess(step, obs, judged);
    log(`  Kind: ${fmt(a.kind)}`);
    // Gate on the result, not the label: evaluate every plausible kind (most likely first, until they
    // cover the gate's confidence) and accept only if they all reach the same outcome.
    // A reading that does not apply to the element Jev picked (e.g. "selected" on a combobox) carries no evidence.
    const all = plausible(a.kind).map(kind => ({ kind, ...evaluate(kind, a, obs, values, log) }));
    const results = all.filter(r => !r.inapplicable);
    if (!results.length) return { outcome: "UNVERIFIABLE", reason: all.map(r => r.reason).join("; ") };
    const first = results[0];
    if (results.every(r => r.outcome === first.outcome)) return first;
    return { outcome: "AMBIGUOUS", reason: `Jev could not tell what kind of check this is, and the readings disagree: ${results.map(r => `as a ${r.kind} check it is ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}` };
  }
}

/** Most likely answers first, until together they cover the gate's confidence. */
function plausible(pick: Pick): string[] {
  const out: string[] = [];
  let covered = 0;
  for (const [k, p] of Object.entries(pick.probabilities).sort((x, y) => y[1] - x[1])) {
    if (covered >= GATE_TOP) break;
    out.push(k);
    covered += p;
  }
  return out;
}

type Verdict = { outcome: StepOutcome; reason?: string; inapplicable?: true };

/** Pass/fail for one kind of check, decided by code from the elements Jev identified. */
function evaluate(kind: string, a: Assessment, obs: Observation, values: string[], log: typeof console.log): Verdict {
  if (kind === "fuzzy") {
    if (a.judged === undefined) return { outcome: "UNVERIFIABLE", reason: "this is a subjective check that code cannot compare; rerun with --judged to let Jev judge it" };
    log(`  Judged: p=${a.judged.toFixed(2)}`);
    if (a.judged >= JUDGED_THRESHOLD) return { outcome: "JUDGED_PASSED", reason: `p=${a.judged.toFixed(2)}` };
    if (a.judged <= 1 - JUDGED_THRESHOLD) return { outcome: "JUDGED_FAILED", reason: `p=${a.judged.toFixed(2)}` };
    return { outcome: "AMBIGUOUS", reason: `Jev is unsure whether the page satisfies the check (${Math.round(a.judged * 100)}% yes)` };
  }

  if (kind === "presence" || kind === "absence") {
    if (!values.length) return { outcome: "UNVERIFIABLE", reason: "the check quotes no text to look for (e.g. \"Winter Sale\" should appear)" };
    // Jev names the area the check is scoped to; code looks for the quoted text inside it. As with kinds, every
    // plausible area is checked and they must agree. A text that is nowhere on the page is decided by code alone.
    const has = (text: string) => values.every(v => containsValue(text, v));
    let where = "the page";
    let found = has(obs.pageText);
    if (found) {
      log(`  Area: ${fmt(a.area)}`);
      const seen = new Map<boolean, string>();
      for (const ref of plausible(a.area)) {
        if (ref === AREA_PAGE) seen.set(true, "the page");
        else if (ref === AREA_MISSING) seen.set(false, "the area the check names (that area is not on this screen)");
        else {
          const el = obs.areas.find(e => e.ref === ref);
          if (!el) return { outcome: "ELEMENT_NOT_FOUND", reason: `Jev chose an area that is no longer on the page (${ref})` };
          seen.set(has(el.text), el.line);
        }
      }
      if (seen.size > 1) return { outcome: "AMBIGUOUS", reason: `Jev is unsure where the check says to look, and the candidates give different answers: ${named(a.area, obs)}` };
      [[found, where]] = seen;
    }
    const pass = found === (kind === "presence");
    const text = values.map(v => `"${v}"`).join(" and ");
    return pass ? { outcome: "PASSED" } : { outcome: "ASSERTION_FAILED", reason: `${text} ${found ? "is shown" : "is not shown"} in ${where}${found ? ", expected it to be absent" : ""}` };
  }

  if (kind === "state") {
    log(`  Subject: ${fmt(a.subject)}  State: ${fmt(a.state)}`);
    if (!gate(a.subject) || !gate(a.state)) return { outcome: "AMBIGUOUS", reason: `Jev is unsure which control or which state the check means: control ${named(a.subject, obs)}; state ${named(a.state)}` };
    if (a.subject.choice === "none") return { outcome: "ASSERTION_FAILED", reason: "no element on the page matches what the check describes" };
    const el = obs.readable.find(e => e.ref === a.subject.choice);
    if (!el) return { outcome: "ELEMENT_NOT_FOUND", reason: `Jev chose an element that is no longer on the page (${a.subject.choice})` };
    let [flag, on] = STATE_FLAG[a.state.choice as keyof typeof STATES];
    if (flag === "selected" && el.role === "link") flag = "current"; // a navigation link is "selected" via aria-current
    if (STATE_ROLES[flag] && !STATE_ROLES[flag].includes(el.role)) {
      return { outcome: "UNVERIFIABLE", reason: `a ${el.role} cannot be ${a.state.choice}`, inapplicable: true };
    }
    const has = el.state.split(/\s+/).includes(`[${flag}]`);
    log(`  Compare: ${flag}=${has}, expected ${on}`);
    return has === on ? { outcome: "PASSED" } : { outcome: "ASSERTION_FAILED", reason: `expected ${el.line} to be ${a.state.choice}, but it is not` };
  }

  // kind === "value"
  if (values.length !== 1) return { outcome: "UNVERIFIABLE", reason: "a value check needs exactly one quoted expected value (e.g. the status should be \"Draft\")" };
  log(`  Subject: ${fmt(a.subject)}`);
  if (!gate(a.subject)) return { outcome: "AMBIGUOUS", reason: `Jev is unsure which element the check is about: ${named(a.subject, obs)}` };
  if (a.subject.choice === "none") return { outcome: "ASSERTION_FAILED", reason: "no element on the page shows what the check describes" };
  const el = obs.readable.find(e => e.ref === a.subject.choice);
  if (!el) return { outcome: "ELEMENT_NOT_FOUND", reason: `Jev chose an element that is no longer on the page (${a.subject.choice})` };
  const actual = assertableText(el);
  if (actual === undefined) return { outcome: "UNVERIFIABLE", reason: `${el.line} has no text to compare (only a label)` };
  log(`  Compare: "${values[0]}" in "${actual}"`);
  return containsValue(actual, values[0])
    ? { outcome: "PASSED" }
    : { outcome: "ASSERTION_FAILED", reason: `expected "${values[0]}", but ${el.role}${el.name && el.name !== actual ? ` "${el.name}"` : ""} shows "${actual}"` };
}

const finish = (log: typeof console.log) => (outcome: StepOutcome, reason?: string): StepResult => {
  log(`  => ${outcome}${reason ? `: ${reason}` : ""}`);
  return { outcome, reason };
};

const SPECIAL: Record<string, string> = {
  none: "nothing", [AREA_PAGE]: "anywhere on the page", [AREA_MISSING]: "an area not on this screen",
  scroll: "scroll down", wait: "wait for loading", enter: "press Enter",
};
/** A Jev answer for people: element refs replaced by the element, top 3 as percentages. */
export const named = (p: Pick, obs?: Observation) =>
  Object.entries(p.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => {
    const el = obs && [...obs.readable, ...obs.areas, ...obs.elements].find(e => e.ref === k);
    return `${el ? el.line : SPECIAL[k] ?? k} ${Math.round(v * 100)}%`;
  }).join(", ");

const fmt = (p: Pick) =>
  Object.entries(p.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");

/** Action or Attempt step. An Attempt is done once its actions are performed, even if the app rejects them. */
export async function runStep(step: string, rt: Runtime, decider: Decider, log = console.log, attempt = false): Promise<StepResult> {
  log(`\n${attempt ? "Attempt" : "Step"}: ${step}`);
  const end = finish(log);
  const recent: string[] = []; // this Step's actions, sent to Jev so it knows what it already did
  let unchanged = 0;
  let obs = await rt.observe();

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    log(`\n  Observation #${turn}:`);
    for (const e of obs.elements) log(`    [${e.ref}] ${e.line}`);

    const t = await decider.turn(step, obs, recent, attempt);
    log(`  Decision: done=${t.done.toFixed(2)} target: ${fmt(t.target)}`);
    if (t.done >= DONE_THRESHOLD) return end("DONE");
    if (!gate(t.target)) return end("AMBIGUOUS", `Jev is unsure what to do next: ${named(t.target, obs)}`);
    if (t.target.choice === "none") return end("BLOCKED", "nothing on this screen helps do the step");

    let action: Action;
    let described: string;
    if (t.target.choice in pageActions(obs)) {
      action = { verb: PAGE_VERBS[t.target.choice] };
      described = action.verb;
    } else {
      const el = obs.elements.find(e => e.ref === t.target.choice);
      if (!el) return end("ELEMENT_NOT_FOUND", `Jev chose an element that is no longer on the page (${t.target.choice})`);
      action = { verb: el.verb, ref: el.ref };
      if (el.verb !== "CLICK") {
        const candidates = el.verb === "SELECT" ? el.options : stepValues(step);
        if (!candidates.length) return end("AMBIGUOUS", `the step gives no value to enter into ${el.line}; quote it (e.g. enter "Winter Sale")`);
        const v = await decider.value(step, obs, el, candidates);
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
    unchanged = next.text === obs.text ? unchanged + 1 : 0;
    if (unchanged >= 2) return end("BLOCKED", `the page did not change after two actions (last: ${described})`);
    obs = next;
  }
  return end("STEP_TIMEOUT", `not done after ${MAX_TURNS} actions (${recent.join(", ")})`);
}
