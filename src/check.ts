// Assertion evaluation (issue #81): Jev resolves, in one request, what a check compares, whether it is negated, and
// which element or area it is about (decision.ts Assessment); code compares, then applies the negation. A comparison
// that cannot be made yet (PENDING) or at all (UNVERIFIABLE) has no truth value, and negating it never makes a pass.
import {
  AREA_MISSING,
  AREA_PAGE,
  confidence,
  fmt,
  gate,
  GATE_MARGIN,
  named,
  plausible,
  type Assessment,
  type Pick,
  type STATES,
} from "./decision.ts";
import { assertableText, sameContent, within, type Element, type Observation } from "./observation.ts";
import type { StepOutcome } from "./runner.ts";

export interface Expectation {
  values: string[];
  table?: string[][];
  list?: boolean;
  exact?: boolean;
  recall?: Pick;
}

// A space before closing punctuation is dropped: snapshots join text nodes with one ("cart !").
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ ([!?.,;:)])/g, "$1")
    .trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-word, case/space-insensitive containment: "1 week" must not match "11 weeks". Only a neighbour of the same kind
 * (letter next to letter, digit next to digit) joins words: snapshots drop line breaks ("1815<br>London" -> "1815London").
 */
export function containsValue(actual: string, expected: string): boolean {
  const e = norm(expected);
  const kind = (c = "") => (/\p{L}/u.test(c) ? "\\p{L}" : /\p{N}/u.test(c) ? "\\p{N}" : undefined);
  const [before, after] = [kind(e[0]), kind(e.at(-1))];
  return new RegExp(`${before ? `(?<!${before})` : ""}${escape(e)}${after ? `(?!${after})` : ""}`, "u").test(
    norm(actual),
  );
}

const STATE_FLAG: Record<keyof typeof STATES, [flag: string, on: boolean]> = {
  disabled: ["disabled", true],
  enabled: ["disabled", false],
  checked: ["checked", true],
  unchecked: ["checked", false],
  expanded: ["expanded", true],
  collapsed: ["expanded", false],
  selected: ["selected", true],
  unselected: ["selected", false],
  pressed: ["pressed", true],
  unpressed: ["pressed", false],
};
// Roles that can carry each ARIA state (WAI-ARIA 1.2). `disabled` applies to any control, so it has no entry.
const STATE_ROLES: Record<string, string[]> = {
  checked: ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio", "option", "treeitem"],
  selected: ["option", "tab", "row", "gridcell", "columnheader", "rowheader", "treeitem"],
  expanded: [
    "button",
    "combobox",
    "link",
    "menuitem",
    "tab",
    "treeitem",
    "row",
    "gridcell",
    "rowheader",
    "checkbox",
    "listbox",
    "application",
  ],
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
  agreeing.reduce((s, k) => s + (pick.probabilities[k] ?? 0), 0) < confidence(pick).answer + MARGINAL_BAND
    ? [`${what}: ${named(pick, obs)}`]
    : [];
/** A gated answer (state, recall) that cleared its gate by less than the band. */
const weakGate = (what: string, pick: Pick): string[] =>
  gate(pick, confidence(pick).answer + MARGINAL_BAND, GATE_MARGIN + MARGINAL_BAND) ? [] : [`${what}: ${named(pick)}`];

/**
 * A reading's outcome: a Step outcome, or PENDING: the evidence it needs may still arrive (a scope not on the screen
 * yet, a list still loading), so the runner retries it and reports UNVERIFIABLE at its deadline.
 */
export type Outcome = StepOutcome | "PENDING";
type Reading = { outcome: Outcome; reason?: string; inapplicable?: true; marginal?: string[] };

/**
 * What one reading's evidence establishes about its condition: a truth value, with the reason a check expecting the
 * other one fails (`fails`), or none (`unknown`) and why.
 */
type Truth =
  | { holds: boolean; fails: string }
  | {
      unknown: "PENDING" | "UNVERIFIABLE" | "AMBIGUOUS" | "ELEMENT_NOT_FOUND";
      reason: string;
      inapplicable?: true;
    };

/** Applies the check's expected truth value after evaluation: an unknown truth value stays unknown when negated. */
function meets(t: Truth, expected: boolean): Reading {
  if ("unknown" in t)
    return { outcome: t.unknown, reason: t.reason, ...(t.inapplicable ? { inapplicable: true } : {}) };
  return t.holds === expected ? { outcome: "PASSED" } : { outcome: "ASSERTION_FAILED", reason: t.fails };
}

const KNOWN = new Set<Outcome>(["PASSED", "ASSERTION_FAILED", "JUDGED_PASSED", "JUDGED_FAILED"]);
/** Unknown outcomes in the order one decides for all readings: being unsure of a meaning comes first. */
const UNKNOWN: Outcome[] = ["AMBIGUOUS", "ELEMENT_NOT_FOUND", "PENDING", "UNVERIFIABLE"];

/**
 * The confidence policy (issue #81) over the plausible readings of a check (plausible(): the most likely answers that
 * together cover the confidence gate). Readings that cannot apply were dropped before. Known truth values that differ:
 * AMBIGUOUS. A reading with no truth value is never outvoted by one that has one: the first in UNKNOWN order decides.
 * Readings that agree carry the pass together; `marginal` names answers too weak to carry it alone.
 */
function agreement(readings: Reading[], disagreement: string, marginal: string[]): Reading {
  const first = readings[0];
  if (!first) return { outcome: "UNVERIFIABLE", reason: "no plausible reading of the check" };
  const known = readings.filter((r) => KNOWN.has(r.outcome));
  if (known.some((r) => r.outcome !== known[0].outcome)) return { outcome: "AMBIGUOUS", reason: disagreement };
  for (const outcome of UNKNOWN) {
    const r = readings.find((x) => x.outcome === outcome);
    if (r) return { outcome, reason: r.reason };
  }
  if (first.outcome !== "PASSED") return first;
  return { ...first, marginal: [...new Set([...marginal, ...readings.flatMap((r) => r.marginal ?? [])])] };
}

const areaDisagreement = (a: Assessment, obs: Observation) =>
  `Jev is unsure where the check says to look, and the candidates give different answers: ${named(a.area, obs)}`;

/**
 * Why a scope's content may not be final yet (undefined: the whole page), or undefined: a busy marker on it, inside it
 * or around it (`aria-busy`, an indeterminate progress bar), or a request the page made still in flight. Network quiet
 * does not prove a scope complete, but a request in flight shows it may not be. An app that shows none of these while
 * it loads needs a Step that waits for what the loaded scope shows.
 */
function incomplete(scope: Element | undefined, obs: Observation): string | undefined {
  return busy(scope, obs) ?? obs.loading;
}
/** A busy marker on `el`, inside it or around it (undefined: anywhere on the page). */
function busy(el: Element | undefined, obs: Observation): string | undefined {
  const marker = obs.busy?.find((b) => !el || within(b, el) || within(el, b));
  return marker && `${marker.line} is still loading`;
}
const where = (scope: Element | undefined) => (scope ? scope.line : "the page");

/**
 * Literal containment of the quoted texts in a scope. Shown (`expected` true) needs every one; not shown is disproved
 * by any one: none may be shown, not "not all of them". A text shown proves containment at once; none shown disproves
 * it only in a complete scope.
 */
function contains(values: string[], scope: Element | undefined, obs: Observation, expected: boolean): Truth {
  const every = expected;
  const text = scope ? scope.text : obs.pageText;
  const shown = values.filter((v) => containsValue(text, v));
  const quoted = values.map((v) => `"${v}"`).join(every ? " and " : " or ");
  if (every ? shown.length === values.length : shown.length > 0)
    return {
      holds: true,
      fails: `${quoted} is shown in ${where(scope)}${expected ? "" : ", expected it to be absent"}`,
    };
  const loading = incomplete(scope, obs);
  if (loading) return { unknown: "PENDING", reason: `${quoted} is not shown in ${where(scope)}, but ${loading}` };
  return { holds: false, fails: `${quoted} is not shown in ${where(scope)}` };
}

/**
 * Each plausible area the check names, evaluated by `inScope` (undefined: the page). As with kinds, every plausible
 * area is evaluated and they must agree. An area not on this screen holds no evidence yet: PENDING, never a truth value.
 */
function inAreas(
  a: Assessment,
  obs: Observation,
  log: (line: string) => void,
  what: string,
  inScope: (scope: Element | undefined) => Reading,
): Reading {
  // Words that surely name no area (`"Saved" should appear`) read the whole page: where Jev would look on this
  // screen does not matter then (issue #92). Any doubt, or a recording from before the question: the area answer.
  if (a.scoped?.choice === "no" && gate(a.scoped)) {
    log(`  Area: page (the check names none: ${fmt(a.scoped)})`);
    return agreement([inScope(undefined)], "", weakMass("names no area", a.scoped, ["no"]));
  }
  log(`  Area: ${fmt(a.area)}`);
  const areas = plausible(a.area);
  const readings: Reading[] = [];
  for (const ref of areas) {
    if (ref === AREA_PAGE) readings.push(inScope(undefined));
    else if (ref === AREA_MISSING)
      readings.push({ outcome: "PENDING", reason: `the ${what} the check names is not on this screen` });
    else {
      const el = obs.areas.find((e) => e.ref === ref);
      if (!el)
        return { outcome: "ELEMENT_NOT_FOUND", reason: `Jev chose an area that is no longer on the page (${ref})` };
      readings.push(inScope(el));
    }
  }
  // Reversed: when the areas agree, the reason names the last one, as reports always have.
  return agreement(readings.reverse(), areaDisagreement(a, obs), weakMass("area", a.area, areas, obs));
}

/** Pass/fail for one kind of check, decided by code from the elements Jev identified; `negated`: it should not be so. */
function evaluate(
  kind: string,
  negated: boolean,
  a: Assessment,
  obs: Observation,
  values: string[],
  log: (line: string) => void,
): Reading {
  if (kind === "fuzzy") {
    if (a.judged === undefined)
      return {
        outcome: "UNVERIFIABLE",
        reason: "this is a subjective check that code cannot compare; rerun with --judged to let Jev judge it",
      };
    log(`  Judged: p=${a.judged.toFixed(2)}`);
    if (a.judged >= JUDGED_THRESHOLD) return { outcome: "JUDGED_PASSED", reason: `p=${a.judged.toFixed(2)}` };
    if (1 - a.judged >= JUDGED_THRESHOLD) return { outcome: "JUDGED_FAILED", reason: `p=${a.judged.toFixed(2)}` };
    return {
      outcome: "AMBIGUOUS",
      reason: `Jev is unsure whether the page satisfies the check (${Math.round(a.judged * 100)}% yes)`,
    };
  }
  const expected = !negated;

  if (kind === "presence") {
    if (!values.length)
      return {
        outcome: "UNVERIFIABLE",
        reason: 'the check quotes no text to look for (e.g. "Winter Sale" should appear)',
      };
    return inAreas(a, obs, log, "area", (scope) => meets(contains(values, scope, obs, expected), expected));
  }

  if (kind === "state") {
    // A state names its own polarity (enabled, unchecked): the required state is the condition.
    log(`  Subject: ${fmt(a.subject)}  State: ${fmt(a.state)}`);
    if (!gate(a.state))
      return { outcome: "AMBIGUOUS", reason: `Jev is unsure which state the check means: ${named(a.state)}` };
    return bySubject(a, obs, "control", (ref) => meets(stateOf(ref, a, obs), true), weakGate("state", a.state));
  }
  if (values.length !== 1)
    return {
      outcome: "UNVERIFIABLE",
      reason: 'a value check needs exactly one quoted expected value (e.g. the status should be "Draft")',
    };
  log(`  Subject: ${fmt(a.subject)}`);
  return bySubject(a, obs, "element", (ref) => meets(valueOf(ref, obs, values[0], expected, log), expected));
}

/**
 * State and value checks read one element. Jev may be unsure which, e.g. a repository name shown in the breadcrumb
 * and the title: as with kinds and areas, every plausible element is checked (`read`) and they must agree.
 */
function bySubject(
  a: Assessment,
  obs: Observation,
  what: string,
  read: (ref: string) => Reading,
  marginal: string[] = [],
): Reading {
  // A reading that cannot apply (a link's text is its label, a link cannot be checked) carries no evidence.
  const subjects = plausible(a.subject);
  const all = subjects.map(read);
  const readings = all.filter((r) => !r.inapplicable);
  // No subject applies: unchanged from a single reading. A value check on a label stays a final UNVERIFIABLE, so a
  // plausible presence reading of the same check cannot pass on the label's text.
  if (!readings.length) return what === "element" ? { outcome: all[0].outcome, reason: all[0].reason } : all[0];
  // A subject that cannot be read but only wraps one that can (a button "Model" holding "mock-model") is the same
  // answer: its confidence counts for the reading.
  const readable = subjects.filter((_, i) => !all[i].inapplicable);
  const element = (ref: string) => obs.readable.find((e) => e.ref === ref);
  const wrapping = subjects.filter((ref, i) => {
    const el = element(ref);
    return all[i].inapplicable && el && readable.some((r) => element(r) && sameContent(el, element(r)!));
  });
  return agreement(
    readings,
    `Jev is unsure which ${what} the check is about, and they give different answers: ${named(a.subject, obs)}`,
    [...weakMass("subject", a.subject, [...readable, ...wrapping], obs), ...marginal],
  );
}

const TABLES = new Set(["table", "grid", "treegrid"]);
const cellText = (c: Element) => (c.name || c.text).trim();
const tableOf = (row: Element) => {
  for (let p = row.parent; p; p = p.parent) if (TABLES.has(p.role)) return p;
};
const isHeader = (row: Element) => !!row.cells?.length && row.cells.every((c) => c.role === "columnheader");
/** Column of `name` among the header's: same text, else the header containing it (a sort arrow, "Quantity ▲"). */
const column = (header: string[], name: string) => {
  const i = header.findIndex((h) => norm(h) === norm(name));
  return i >= 0 ? i : header.findIndex((h) => containsValue(h, name));
};

/**
 * A check's table (header row, then expected rows) against the page rows in each plausible area: every expected row
 * must match a page row by column header (extra page rows allowed, order free); `exact`: the same rows in this order.
 */
function matchRows(a: Assessment, obs: Observation, table: string[][], exact: boolean, log: (line: string) => void) {
  return inAreas(a, obs, log, "table", (area) => rowsIn(area, obs, table, exact));
}

/**
 * `area` undefined: the whole page. A cell matches when it shows the expected value. Each expected row matched proves the
 * rows are listed; a missing row, or anything but these rows for `exact`, is proven only by a complete table, except a
 * page row no expected row matches, which already disproves `exact`.
 */
function rowsIn(area: Element | undefined, obs: Observation, table: string[][], exact: boolean): Reading {
  const [names, ...expected] = table;
  const at = where(area);
  const loading = incomplete(area, obs);
  const unproven = (reason: string): Reading =>
    loading ? { outcome: "PENDING", reason: `${reason}, but ${loading}` } : { outcome: "ASSERTION_FAILED", reason };
  const rows = obs.areas.filter((r) => r.role === "row" && r.cells?.length && (!area || within(r, area)));
  const header = (row: Element) =>
    rows
      .concat(obs.areas)
      .find((h) => h.role === "row" && isHeader(h) && tableOf(h) === tableOf(row))
      ?.cells?.map(cellText) ?? [];
  const data = rows.filter((r) => !isHeader(r));
  if (!data.length) return unproven(`${at} shows no table rows`);
  const noColumn = names.find((n) => !data.some((r) => column(header(r), n) >= 0));
  if (noColumn !== undefined)
    return unproven(
      `the table in ${at} has no column "${noColumn}" (columns: ${[...new Set(data.flatMap(header))].join(", ")})`,
    );
  const matches = (row: Element, want: string[]) =>
    names.every((n, i) => {
      const cell = row.cells![column(header(row), n)];
      if (cell === undefined) return false;
      return want[i] ? containsValue(cellText(cell), want[i]) : !cellText(cell); // an empty expected cell is an empty cell
    });
  const show = (want: string[]) => names.map((n, i) => `${n}=${want[i]}`).join(", ");
  const shown = `its rows: ${data.map((r) => r.cells!.map(cellText).join(" | ")).join("; ")}`;
  if (exact) {
    const failed = `expected exactly these rows in this order: ${expected.map(show).join("; ")}; ${at} has ${shown}`;
    // A page row that no expected row matches disproves "exactly these rows" whatever else loads.
    if (data.some((r) => !expected.some((want) => matches(r, want))))
      return { outcome: "ASSERTION_FAILED", reason: failed };
    if (data.length === expected.length && expected.every((want, i) => matches(data[i], want)))
      return loading ? { outcome: "PENDING", reason: `${at} shows these rows, but ${loading}` } : { outcome: "PASSED" };
    return unproven(failed);
  }
  const free = [...data];
  for (const want of expected) {
    const i = free.findIndex((r) => matches(r, want));
    if (i < 0) return unproven(`expected row ${show(want)} is not in ${at}; ${shown}`);
    free.splice(i, 1); // each page row matches one expected row
  }
  return { outcome: "PASSED" };
}

/**
 * The element a state or value check reads, or why it gives no evidence: a subject that is not on the page has no
 * state and shows no value ("not disabled" is not shown by a missing button), so its answer is PENDING.
 */
function subjectOf(ref: string, obs: Observation, none: string): Element | Truth {
  if (ref === "none") return { unknown: "PENDING", reason: none };
  return (
    obs.readable.find((e) => e.ref === ref) ?? {
      unknown: "ELEMENT_NOT_FOUND",
      reason: `Jev chose an element that is no longer on the page (${ref})`,
    }
  );
}

/** Is the control in the state the check requires? */
function stateOf(ref: string, a: Assessment, obs: Observation): Truth {
  const el = subjectOf(ref, obs, "no element on the page is the control the check is about");
  if (!("ref" in el)) return el;
  let [flag, on] = STATE_FLAG[a.state.choice as keyof typeof STATES];
  if (flag === "selected" && el.role === "link") flag = "current"; // a navigation link is "selected" via aria-current
  if (STATE_ROLES[flag] && !STATE_ROLES[flag].includes(el.role))
    return { unknown: "UNVERIFIABLE", reason: `a ${el.role} cannot be ${a.state.choice}`, inapplicable: true };
  // The app says the control is still being updated: its state is not final.
  const loading = busy(el, obs);
  if (loading) return { unknown: "PENDING", reason: loading };
  const has = el.state.split(/\s+/).includes(`[${flag}]`) === on;
  return { holds: has, fails: `expected ${el.line} to be ${a.state.choice}, but it is not` };
}

/**
 * Does the subject show the value: its text holds the quoted text as whole words (case and spacing aside)? Containment
 * cannot tell "Not Scheduled" from "Scheduled for May": quote the whole value where that matters. `expected` false: the
 * check says it should not show it.
 */
function valueOf(ref: string, obs: Observation, value: string, expected: boolean, log: (line: string) => void): Truth {
  const el = subjectOf(ref, obs, "no element on the page shows what the check describes");
  if (!("ref" in el)) return el;
  const actual = assertableText(el);
  if (actual === undefined)
    return { unknown: "UNVERIFIABLE", reason: `${el.line} has no text to compare (only a label)`, inapplicable: true };
  log(`  Compare: "${value}" in "${actual}"`);
  // The app says the element is still being updated: its value is not final.
  const loading = busy(el, obs);
  if (loading) return { unknown: "PENDING", reason: loading };
  if (el.role === "download" && el.state === "[empty]")
    return { holds: false, fails: `the downloaded file is empty (0 bytes)` };
  // URL paths are case-sensitive and not words: plain substring.
  if (el.role === "url")
    return {
      holds: actual.includes(value),
      fails: `expected the URL ${expected ? "" : "not "}to contain "${value}", but it is "${actual}"`,
    };
  const shows = (holds: boolean, text: string): Truth => ({
    holds,
    fails: `expected ${expected ? "" : "anything but "}"${value}", but ${el.role}${el.name && el.name !== actual ? ` "${el.name}"` : ""} shows "${text}"`,
  });
  if (containsValue(actual, value)) return shows(true, actual);
  // The subject shows part of the quoted text (prose split across a link and bare text, "<b>2</b> items left"):
  // the rest can only be in the container holding it, so read that one, not anywhere on the page.
  const host = el.parent;
  if (actual && host && containsValue(value, actual)) {
    log(`  Compare: "${value}" in "${host.text.trim()}" (${host.line}, holding ${el.line})`);
    if (containsValue(host.text, value)) return shows(true, host.text.trim());
  }
  return shows(false, actual);
}

export type Verdict = Reading & { details: string[] };

/** Pure Check verdict; diagnostics are returned for the runner to log, never emitted here. PENDING is not final. */
export function verdict(a: Assessment, obs: Observation, expectation: Expectation): Verdict {
  const details = [`  Kind: ${fmt(a.kind)}  Negated: ${fmt(a.negated)}`];
  const result = check(a, obs, expectation, (line) => details.push(line));
  if (result.outcome === "PASSED" && expectation.recall) {
    result.marginal = [...weakGate("earlier value", expectation.recall), ...(result.marginal ?? [])];
  }
  return { ...result, details };
}

function check(
  a: Assessment,
  obs: Observation,
  { values, table, list = false, exact = false }: Expectation,
  log: (line: string) => void,
): Reading {
  // Gate on the result, not the label: evaluate every plausible kind (most likely first, until they
  // cover the gate's confidence) and accept only if they all reach the same outcome.
  // A reading that does not apply to the element Jev picked (e.g. "selected" on a combobox) carries no evidence.
  // A table's shape decides the kind; a one-column table is a list of texts to look for.
  const kinds = !table ? plausible(a.kind) : list ? ["presence"] : ["rows"];
  // Negation is one answer, applied after comparing a text or value; a state names its own, a subjective check is
  // judged whole.
  if (kinds.some((k) => k !== "fuzzy" && k !== "state") && !gate(a.negated))
    return {
      outcome: "AMBIGUOUS",
      reason: `Jev is unsure whether the check says it should or should not be so: ${named(a.negated)}`,
    };
  const negated = a.negated.choice === "yes";
  if (table && !list && negated)
    return {
      outcome: "UNVERIFIABLE",
      reason: "a check that table rows are not shown is not supported; check each row's absence in its own Step",
    };
  const all = kinds.map((kind) => ({
    kind,
    ...(kind === "rows" ? matchRows(a, obs, table!, exact, log) : evaluate(kind, negated, a, obs, values, log)),
  }));
  const applicable = all.filter((r) => !r.inapplicable);
  if (!applicable.length) return { outcome: "UNVERIFIABLE", reason: all.map((r) => r.reason).join("; ") };
  // Every plausible kind counts: one that cannot decide (PENDING, AMBIGUOUS) is not outvoted by one that passed.
  return agreement(
    applicable,
    `Jev could not tell what kind of check this is, and the readings disagree: ${applicable.map((r) => `as a ${r.kind} check it is ${r.outcome}${r.reason ? ` (${r.reason})` : ""}`).join("; ")}`,
    [
      ...(table
        ? []
        : weakMass(
            "kind",
            a.kind,
            applicable.map((r) => r.kind),
          )),
      ...(kinds.some((k) => k !== "fuzzy" && k !== "state") ? weakGate("negation", a.negated) : []),
    ],
  );
}
