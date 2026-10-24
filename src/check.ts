import { AREA_MISSING, AREA_PAGE, gate, GATE_MARGIN, GATE_TOP, plausible, STATES, named, fmt, type Assessment, type Pick } from "./decision.ts";
import { assertableText, type Element, type Observation } from "./observation.ts";
import type { StepOutcome } from "./runner.ts";

export interface Expectation {
  values: string[];
  table?: string[][];
  list?: boolean;
  exact?: boolean;
  recall?: Pick;
}

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

type Reading = { outcome: StepOutcome; reason?: string; inapplicable?: true; marginal?: string[] };

/** All applicable readings must agree; only a pass carries their combined confidence warnings. */
function agreement(readings: Reading[], disagreement: string, marginal: string[]): Reading {
  const first = readings[0];
  if (!first) return { outcome: "UNVERIFIABLE", reason: "no plausible reading of the check" };
  if (readings.some(r => r.outcome !== first.outcome)) return { outcome: "AMBIGUOUS", reason: disagreement };
  if (first.outcome !== "PASSED") return first;
  return { ...first, marginal: [...new Set([...marginal, ...readings.flatMap(r => r.marginal ?? [])])] };
}

const areaDisagreement = (a: Assessment, obs: Observation) =>
  `Jev is unsure where the check says to look, and the candidates give different answers: ${named(a.area, obs)}`;

/** Pass/fail for one kind of check, decided by code from the elements Jev identified. */
function evaluate(kind: string, a: Assessment, obs: Observation, values: string[], log: typeof console.log): Reading {
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
    const text = values.map(v => `"${v}"`).join(kind === "absence" ? " or " : " and ");
    const reading = (found: boolean, where: string): Reading => found === (kind === "presence")
      ? { outcome: "PASSED" }
      : { outcome: "ASSERTION_FAILED", reason: `${text} ${found ? "is shown" : "is not shown"} in ${where}${found ? ", expected it to be absent" : ""}` };
    // Text nowhere on the page rests on no area answer.
    if (!has(obs.pageText)) return reading(false, "the page");
    log(`  Area: ${fmt(a.area)}`);
    const areas = plausible(a.area);
    const readings: Reading[] = [];
    for (const ref of areas) {
      if (ref === AREA_PAGE) readings.push(reading(true, "the page"));
      else if (ref === AREA_MISSING) readings.push(reading(false, "the area the check names (that area is not on this screen)"));
      else {
        const el = obs.areas.find(e => e.ref === ref);
        if (!el) return { outcome: "ELEMENT_NOT_FOUND", reason: `Jev chose an area that is no longer on the page (${ref})` };
        readings.push(reading(has(el.text), el.line));
      }
    }
    // The old area comparison reported the last agreeing area.
    return agreement(readings.reverse(), areaDisagreement(a, obs), weakMass("area", a.area, areas, obs));
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
  const marginal = weakMass("subject", a.subject, subjects.filter((_, i) => !all[i].inapplicable), obs);
  const what = kind === "state" ? "control" : "element";
  return agreement(readings,
    `Jev is unsure which ${what} the check is about, and they give different answers: ${named(a.subject, obs)}`,
    kind === "state" ? [...marginal, ...weakGate("state", a.state)] : marginal);
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
function matchRows(a: Assessment, obs: Observation, table: string[][], exact: boolean, log: typeof console.log): Reading {
  log(`  Area: ${fmt(a.area)}`);
  const areas = plausible(a.area);
  const verdicts: Reading[] = [];
  for (const ref of areas) {
    if (ref === AREA_MISSING) { verdicts.push({ outcome: "ASSERTION_FAILED", reason: "the table the check names is not on this screen" }); continue; }
    const area = obs.areas.find(e => e.ref === ref);
    if (ref !== AREA_PAGE && !area) return { outcome: "ELEMENT_NOT_FOUND", reason: `Jev chose an area that is no longer on the page (${ref})` };
    verdicts.push(rowsIn(area, obs, table, exact));
  }
  return agreement(verdicts, areaDisagreement(a, obs), weakMass("area", a.area, areas, obs));
}

/** `area` undefined: the whole page. */
function rowsIn(area: Element | undefined, obs: Observation, table: string[][], exact: boolean): Reading {
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

function stateOf(ref: string, a: Assessment, obs: Observation): Reading {
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

function valueOf(ref: string, _a: Assessment, obs: Observation, values: string[], log: typeof console.log): Reading {
  if (ref === "none") return { outcome: "ASSERTION_FAILED", reason: "no element on the page shows what the check describes" };
  const el = obs.readable.find(e => e.ref === ref);
  if (!el) return { outcome: "ELEMENT_NOT_FOUND", reason: `Jev chose an element that is no longer on the page (${ref})` };
  const actual = assertableText(el);
  if (actual === undefined) return { outcome: "UNVERIFIABLE", reason: `${el.line} has no text to compare (only a label)`, inapplicable: true };
  log(`  Compare: "${values[0]}" in "${actual}"`);
  if (el.role === "download" && el.state === "[empty]") return { outcome: "ASSERTION_FAILED", reason: `the downloaded file is empty (0 bytes)` };
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

export type Verdict = Reading & { details: string[] };

/** Pure Check verdict; diagnostics are returned for the runner to log, never emitted here. */
export function verdict(a: Assessment, obs: Observation, expectation: Expectation): Verdict {
  const details = [`  Kind: ${fmt(a.kind)}`];
  const result = check(a, obs, expectation, line => { details.push(line); });
  if (result.outcome === "PASSED" && expectation.recall) {
    result.marginal = [...weakGate("earlier value", expectation.recall), ...result.marginal ?? []];
  }
  return { ...result, details };
}

function check(a: Assessment, obs: Observation, { values, table, list = false, exact = false }: Expectation, log: (line: string) => void): Reading {
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
  return agreement(results,
    `Jev could not tell what kind of check this is, and the readings disagree: ${results.map(r => `as a ${r.kind} check it is ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}`,
    table ? [] : weakMass("kind", a.kind, results.map(r => r.kind)));
}
