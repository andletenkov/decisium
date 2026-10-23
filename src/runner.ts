import type { Action } from "./browser.ts";
import { readStep, type StepArgument } from "./step.ts";
import { AREA_MISSING, AREA_PAGE, gate, GATE_MARGIN, GATE_TARGET_MARGIN, GATE_TARGET_TOP, GATE_TOP, NotYet, pageActions, plausible, STATES, type Assessment, type Decider, type Pick, type TurnAnswer } from "./decision.ts";
import { assertableText, MASK, type Dialog, type Element, type Observation } from "./observation.ts";

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
  /** Browser dialogs (task 0040): an action Step forgets the last dialog's message when it starts... */
  forgetDialog?(): void;
  /** ...and dismisses a dialog still open when it ends; returns that dialog, for the log. */
  dismissDialog?(): Promise<Dialog | undefined>;
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
const PAGE_VERBS: Record<string, Action["verb"]> = { scroll: "SCROLL", wait: "WAIT", enter: "ENTER" };
const ASSERT_TIMEOUT_MS = 5000; // total time an Assertion step may wait for the UI to reach the expected state
const DONE_THRESHOLD = 0.8;
/**
 * After an action that changed the page, "nothing left to do" is evidence too: with it, done needs only this much
 * (task 0007). In the corpus every such Turn with done >= 0.5 was a real success (SauceDemo cart 0.58-0.77).
 */
const DONE_AFTER_ACTION = 0.5;

// A space before closing punctuation is dropped: snapshots join text nodes with one ("cart !").
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/ ([!?.,;:)])/g, "$1").trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-word, case/space-insensitive containment: "1 week" must not match "11 weeks". Only a neighbour of the same kind
 * (letter next to letter, digit next to digit) joins words: snapshots drop line breaks ("1815<br>London" -> "1815London").
 */
export function containsValue(actual: string, expected: string): boolean {
  const e = norm(expected);
  const kind = (c = "") => /\p{L}/u.test(c) ? "\\p{L}" : /\p{N}/u.test(c) ? "\\p{N}" : undefined;
  const [before, after] = [kind(e[0]), kind(e.at(-1))];
  return new RegExp(`${before ? `(?<!${before})` : ""}${escape(e)}${after ? `(?!${after})` : ""}`, "u").test(norm(actual));
}

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
 * A pass resting on an answer less than this above its gate is marginal (task 0027). On the corpus (29 passes) it
 * flags 6: the answers that agree carry 0.69-0.89 together.
 */
const MARGINAL_BAND = 0.1;

/** Readings that agree (`agreeing`) carry the pass together; under gate + band they are a marginal answer. */
const weakMass = (what: string, pick: Pick, agreeing: string[], obs?: Observation): string[] =>
  agreeing.reduce((s, k) => s + (pick.probabilities[k] ?? 0), 0) < GATE_TOP + MARGINAL_BAND ? [`${what}: ${named(pick, obs)}`] : [];
/** A gated answer (state, recall) that cleared its gate by less than the band. */
const weakGate = (what: string, pick: Pick): string[] =>
  gate(pick, GATE_TOP + MARGINAL_BAND, GATE_MARGIN + MARGINAL_BAND) ? [] : [`${what}: ${named(pick)}`];

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
  let recallWeak: string[] = [];
  if (!values.length && !table && Object.keys(earlier).length) {
    const r = await decider.recall(said, earlier);
    log(`  Recall: ${fmt(r)}`);
    if (gate(r) && r.choice !== "none") { values.push(r.choice); recallWeak = weakGate("earlier value", r); }
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
    if (verdict.outcome === "PASSED") verdict.marginal = [...recallWeak, ...verdict.marginal ?? []];
    if (final || left <= 0) return end(verdict.outcome, verdict.reason, verdict.marginal);
    log("  (not passed yet; waiting for the UI to change)");
    if (!(await rt.waitForChange(obs.text, left))) return end(verdict.outcome, verdict.reason);
    obs = await rt.observe();
  }

  async function check(obs: Observation): Promise<Verdict> {
    const a = await decider.assess(said, obs, judged);
    log(`  Kind: ${fmt(a.kind)}`);
    // Gate on the result, not the label: evaluate every plausible kind (most likely first, until they
    // cover the gate's confidence) and accept only if they all reach the same outcome.
    // A reading that does not apply to the element Jev picked (e.g. "selected" on a combobox) carries no evidence.
    // A table's shape decides the kind, except that Jev's absence reading must not be lost ("should not show:").
    const negated = plausible(a.kind).includes("absence");
    if (table && !list && negated) return { outcome: "UNVERIFIABLE", reason: "a check that table rows are not shown is not supported; check each row's absence in its own Step" };
    const kinds = !table ? plausible(a.kind) : list ? [...new Set(plausible(a.kind).map(k => k === "absence" ? k : "presence"))] : ["rows"];
    const all = kinds.map(kind => ({ kind, ...kind === "rows" ? matchRows(a, obs, table!, exact, log) : evaluate(kind, a, obs, values, log) }));
    const results = all.filter(r => !r.inapplicable);
    if (!results.length) return { outcome: "UNVERIFIABLE", reason: all.map(r => r.reason).join("; ") };
    const first = results[0];
    if (results.every(r => r.outcome === first.outcome)) {
      if (first.outcome !== "PASSED") return first;
      const marginal = [...table ? [] : weakMass("kind", a.kind, results.map(r => r.kind)), ...results.flatMap(r => r.marginal ?? [])];
      return { ...first, marginal: [...new Set(marginal)] };
    }
    return { outcome: "AMBIGUOUS", reason: `Jev could not tell what kind of check this is, and the readings disagree: ${results.map(r => `as a ${r.kind} check it is ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}` };
  }
}

type Verdict = { outcome: StepOutcome; reason?: string; inapplicable?: true; marginal?: string[] };

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
    // Presence needs every quoted text; absence fails on any one of them, so "any shown" is what it must look for.
    const has = (text: string) => kind === "absence"
      ? values.some(v => containsValue(text, v))
      : values.every(v => containsValue(text, v));
    let where = "the page";
    let found = has(obs.pageText);
    let marginal: string[] = []; // a text nowhere on the page rests on no area answer
    if (found) {
      log(`  Area: ${fmt(a.area)}`);
      const seen = new Map<boolean, string>();
      const areas = plausible(a.area);
      marginal = weakMass("area", a.area, areas, obs);
      for (const ref of areas) {
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
    const text = values.map(v => `"${v}"`).join(kind === "absence" ? " or " : " and ");
    return pass ? { outcome: "PASSED", marginal } : { outcome: "ASSERTION_FAILED", reason: `${text} ${found ? "is shown" : "is not shown"} in ${where}${found ? ", expected it to be absent" : ""}` };
  }

  // State and value checks read one element. Jev may be unsure which, e.g. a repository name shown in the breadcrumb
  // and the title: as with kinds and areas, every plausible element is checked and they must agree.
  if (kind === "state") {
    log(`  Subject: ${fmt(a.subject)}  State: ${fmt(a.state)}`);
    if (!gate(a.state)) return { outcome: "AMBIGUOUS", reason: `Jev is unsure which state the check means: ${named(a.state)}` };
  } else {
    if (values.length !== 1) return { outcome: "UNVERIFIABLE", reason: "a value check needs exactly one quoted expected value (e.g. the status should be \"Draft\")" };
    log(`  Subject: ${fmt(a.subject)}`);
  }
  // A reading that cannot apply (a link's text is its label, a link cannot be checked) carries no evidence.
  const subjects = plausible(a.subject);
  const all = subjects.map(ref => (kind === "state" ? stateOf : valueOf)(ref, a, obs, values, log));
  const readings = all.filter(r => !r.inapplicable);
  // No subject applies: unchanged from a single reading. A value check on a label stays a final UNVERIFIABLE, so a
  // plausible presence reading of the same check cannot pass on the label's text.
  if (!readings.length) return kind === "value" ? { outcome: all[0].outcome, reason: all[0].reason } : all[0];
  if (readings.every(r => r.outcome === readings[0].outcome)) {
    if (readings[0].outcome !== "PASSED") return readings[0];
    const marginal = weakMass("subject", a.subject, subjects.filter((_, i) => !all[i].inapplicable), obs);
    return { ...readings[0], marginal: kind === "state" ? [...marginal, ...weakGate("state", a.state)] : marginal };
  }
  const what = kind === "state" ? "control" : "element";
  return { outcome: "AMBIGUOUS", reason: `Jev is unsure which ${what} the check is about, and they give different answers: ${named(a.subject, obs)}` };
}

const TABLES = new Set(["table", "grid", "treegrid"]);
const cellText = (c: Element) => (c.name || c.text).trim();
const within = (el: Element, area: Element) => { for (let p: Element | undefined = el; p; p = p.parent) if (p === area) return true; return false; };
const tableOf = (row: Element) => { for (let p = row.parent; p; p = p.parent) if (TABLES.has(p.role)) return p; };
const isHeader = (row: Element) => !!row.cells?.length && row.cells.every(c => c.role === "columnheader");
/** Column of `name` among the header's: same text, else the header containing it (a sort arrow, "Quantity ▲"). */
const column = (header: string[], name: string) => {
  const i = header.findIndex(h => norm(h) === norm(name));
  return i >= 0 ? i : header.findIndex(h => containsValue(h, name));
};

/**
 * A check's table (header row, then expected rows) against the page rows in each plausible area: every expected row
 * must match a page row by column header (extra page rows allowed, order free); `exact`: the same rows in this order.
 */
function matchRows(a: Assessment, obs: Observation, table: string[][], exact: boolean, log: typeof console.log): Verdict {
  log(`  Area: ${fmt(a.area)}`);
  const areas = plausible(a.area);
  const verdicts: Verdict[] = [];
  for (const ref of areas) {
    if (ref === AREA_MISSING) { verdicts.push({ outcome: "ASSERTION_FAILED", reason: "the table the check names is not on this screen" }); continue; }
    const area = obs.areas.find(e => e.ref === ref);
    if (ref !== AREA_PAGE && !area) return { outcome: "ELEMENT_NOT_FOUND", reason: `Jev chose an area that is no longer on the page (${ref})` };
    verdicts.push(rowsIn(area, obs, table, exact));
  }
  if (verdicts.some(v => v.outcome !== verdicts[0].outcome)) return { outcome: "AMBIGUOUS", reason: `Jev is unsure where the check says to look, and the candidates give different answers: ${named(a.area, obs)}` };
  return verdicts[0].outcome === "PASSED" ? { outcome: "PASSED", marginal: weakMass("area", a.area, areas, obs) } : verdicts[0];
}

/** `area` undefined: the whole page. */
function rowsIn(area: Element | undefined, obs: Observation, table: string[][], exact: boolean): Verdict {
  const [names, ...expected] = table;
  const where = area ? area.line : "the page";
  const rows = obs.areas.filter(r => r.role === "row" && r.cells?.length && (!area || within(r, area)));
  const header = (row: Element) => rows.concat(obs.areas).find(h => h.role === "row" && isHeader(h) && tableOf(h) === tableOf(row))?.cells!.map(cellText) ?? [];
  const data = rows.filter(r => !isHeader(r));
  if (!data.length) return { outcome: "ASSERTION_FAILED", reason: `${where} shows no table rows` };
  const noColumn = names.find(n => !data.some(r => column(header(r), n) >= 0));
  if (noColumn !== undefined) return { outcome: "ASSERTION_FAILED", reason: `the table in ${where} has no column "${noColumn}" (columns: ${[...new Set(data.flatMap(header))].join(", ")})` };
  const matches = (row: Element, want: string[]) => names.every((n, i) => {
    const cell = row.cells![column(header(row), n)];
    return cell !== undefined && (want[i] ? containsValue(cellText(cell), want[i]) : !cellText(cell)); // an empty expected cell is an empty cell
  });
  const show = (want: string[]) => names.map((n, i) => `${n}=${want[i]}`).join(", ");
  const shown = `its rows: ${data.map(r => r.cells!.map(cellText).join(" | ")).join("; ")}`;
  if (exact) {
    if (data.length === expected.length && expected.every((want, i) => matches(data[i], want))) return { outcome: "PASSED" };
    return { outcome: "ASSERTION_FAILED", reason: `expected exactly these rows in this order: ${expected.map(show).join("; ")}; ${where} has ${shown}` };
  }
  const free = [...data];
  for (const want of expected) {
    const i = free.findIndex(r => matches(r, want));
    if (i < 0) return { outcome: "ASSERTION_FAILED", reason: `expected row ${show(want)} is not in ${where}; ${shown}` };
    free.splice(i, 1); // each page row matches one expected row
  }
  return { outcome: "PASSED" };
}

function stateOf(ref: string, a: Assessment, obs: Observation): Verdict {
  if (ref === "none") return { outcome: "ASSERTION_FAILED", reason: "no element on the page matches what the check describes" };
  const el = obs.readable.find(e => e.ref === ref);
  if (!el) return { outcome: "ELEMENT_NOT_FOUND", reason: `Jev chose an element that is no longer on the page (${ref})` };
  let [flag, on] = STATE_FLAG[a.state.choice as keyof typeof STATES];
  if (flag === "selected" && el.role === "link") flag = "current"; // a navigation link is "selected" via aria-current
  if (STATE_ROLES[flag] && !STATE_ROLES[flag].includes(el.role)) {
    return { outcome: "UNVERIFIABLE", reason: `a ${el.role} cannot be ${a.state.choice}`, inapplicable: true };
  }
  const has = el.state.split(/\s+/).includes(`[${flag}]`);
  return has === on ? { outcome: "PASSED" } : { outcome: "ASSERTION_FAILED", reason: `expected ${el.line} to be ${a.state.choice}, but it is not` };
}

function valueOf(ref: string, _a: Assessment, obs: Observation, values: string[], log: typeof console.log): Verdict {
  if (ref === "none") return { outcome: "ASSERTION_FAILED", reason: "no element on the page shows what the check describes" };
  const el = obs.readable.find(e => e.ref === ref);
  if (!el) return { outcome: "ELEMENT_NOT_FOUND", reason: `Jev chose an element that is no longer on the page (${ref})` };
  const actual = assertableText(el);
  if (actual === undefined) return { outcome: "UNVERIFIABLE", reason: `${el.line} has no text to compare (only a label)`, inapplicable: true };
  log(`  Compare: "${values[0]}" in "${actual}"`);
  // URL paths are case-sensitive and not words: plain substring.
  if (el.role === "url") return actual.includes(values[0]) ? { outcome: "PASSED" } : { outcome: "ASSERTION_FAILED", reason: `expected the URL to contain "${values[0]}", but it is "${actual}"` };
  if (containsValue(actual, values[0])) return { outcome: "PASSED" };
  // The subject shows part of the quoted text (prose split across a link and bare text, "<b>2</b> items left"):
  // the rest can only be in the container holding it, so read that one, not anywhere on the page.
  const host = el.parent;
  if (actual && host && containsValue(values[0], actual)) {
    log(`  Compare: "${values[0]}" in "${host.text.trim()}" (${host.line}, holding ${el.line})`);
    if (containsValue(host.text, values[0])) return { outcome: "PASSED" };
  }
  return { outcome: "ASSERTION_FAILED", reason: `expected "${values[0]}", but ${el.role}${el.name && el.name !== actual ? ` "${el.name}"` : ""} shows "${actual}"` };
}

const finish = (log: typeof console.log) => (outcome: StepOutcome, reason?: string, weak: string[] = []): StepResult => {
  const marginal = weak.length ? weak.join("; ") : undefined;
  log(`  => ${outcome}${reason ? `: ${reason}` : ""}${marginal ? ` (marginal: ${marginal})` : ""}`);
  return { outcome, reason, ...(marginal ? { marginal } : {}) };
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

/**
 * Action or Attempt step. An Attempt is done once its actions are performed, even if the app rejects them.
 * `docString`: one more value to type, read by Jev with the Step.
 */
export async function runStep(step: string, rt: Runtime, decider: Decider, log = console.log, attempt = false, docString?: string): Promise<StepResult> {
  rt.forgetDialog?.();
  const r = await act(step, rt, decider, log, attempt, docString);
  const open = await rt.dismissDialog?.();
  if (open) log(`  Dialog: ${open.type} "${open.message}" was still open when the Step ended: dismissed`);
  return r;
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
  // Only "press X": nothing to choose, so code presses it and the following checks verify the effect (task 0039).
  const key = read.pressOnly;
  if (key) {
    log(`  Execute: PRESS ${key}`);
    try {
      await rt.execute({ verb: "PRESS", value: key });
    } catch (err) {
      return end("ACTION_FAILED", `PRESS ${key} failed: ${(err as Error).message.split("\n")[0]}`);
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
    log(`  Decision: done=${t.done.toFixed(2)} target: ${fmt(t.target)}`);
    if (t.done >= DONE_THRESHOLD) return end("DONE");
    if (recent.length && unchanged === 0 && t.target.choice === "none" && t.done >= DONE_AFTER_ACTION) return end("DONE");
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
      action = { verb: el.verb, ref: el.ref };
      if (el.verb !== "CLICK") {
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
    const goal = read.toggle;
    const box = action.verb === "CLICK" && goal !== undefined ? next.elements.find(e => e.ref === action.ref && TOGGLES.has(e.role)) : undefined;
    if (box && /\[checked\]/.test(box.state) === goal) { log(`  Toggle: ${box.line}`); return end("DONE"); }
    unchanged = next.text === obs.text ? unchanged + 1 : 0;
    if (unchanged >= 2) return end("BLOCKED", `the page did not change after two actions (last: ${described})`);
    obs = next;
  }
  return end("STEP_TIMEOUT", `not done after ${MAX_TURNS} actions (${recent.join(", ")})`);
}
