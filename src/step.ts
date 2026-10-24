// The Step language (task 0052): what a Step's text, Data table and Doc string mean to the runtime, read in one place.
// The runner, Jev's questions, lint, reports and cassette keys all read a Step through readStep().
import { PickleStepType } from "@cucumber/messages";

export type StepKind = "action" | "attempt" | "assertion";

/** A Step's Gherkin argument: a data table (rows of cells) or a doc string. */
export interface StepArgument {
  table?: string[][];
  docString?: string;
}

export interface ParsedStep extends StepArgument {
  text: string;
  kind: StepKind;
  line?: number; // in the .feature file (a Background step: its own line)
}

export interface StepReading {
  /** The Step as reports and cassette keys show it: the table compactly, e.g. `[First name=Ada, Last name=Lovelace]`. */
  label: string;
  /** What runs: an Action step's Data table as one Step per row (none for a header alone), else the text. */
  rows: string[];
  /** Double-quoted strings in the text. Single quotes are left alone so apostrophes ("campaign's") don't open a quote. */
  quoted: string[];
  /** Quoted values and the Doc string; for a check also its one-column table: what it compares, or a prompt can answer. */
  values: string[];
  /** Candidate values an Action step can type: quoted strings, numbers with an optional unit word, the Doc string; clear/empty adds "". */
  candidates: string[];
  /** Named keys after "press" or "hit", as Playwright names them, one per verb. Actions only. */
  keys: string[];
  /** What the Step means as a key (a `+` combination, or "the X key") but is not a key name; never pressed. */
  unknownKeys: string[];
  /** The key of a Step that is only "press X" (`I press Escape`, `hit the "Tab" key`). */
  pressOnly?: string;
  /** A Step that is only "go back", "go forward", "reload the page" or "go to <URL or path>" (task 0041). */
  navigation?: Navigation;
  /** The Step uploads (task 0044): an element it clicks gets one of the quoted values as a file. */
  upload: boolean;
  /** A Step that only checks (true) or unchecks (false) one box; "and"/"then" mean more to do. */
  toggle?: boolean;
  /** A check of rows "exactly" or "in this order". */
  exact: boolean;
  /** The table's first row is a header: a check with 2+ columns, an action with 3+. */
  header: boolean;
  /** A check's one-column table: a list of values that must all be shown. */
  list: boolean;
  /** The `"$NAME"` Secret placeholders: quoted, as the Doc string, or as a table cell. */
  placeholders: string[];
  /** An action's table cell that cannot become a quoted value (rows): empty gives none, a `"` splits it in two. */
  badCell?: string;
}

export function readStep(step: ParsedStep): StepReading {
  const { text, kind, table, docString } = step;
  const isCheck = kind === "assertion";
  const header = !!table && table[0].length > (isCheck ? 1 : 2);
  const list = isCheck && !!table && !header;
  const quotedText = quoted(text);
  const withDoc = docString === undefined ? quotedText : [...quotedText, docString];
  const numbers = [...text.matchAll(/\b\d+(?:[.,]\d+)?(?:\s+[a-z]+)?/gi)].map(m => m[0]);
  const { keys, unknown } = isCheck ? { keys: [], unknown: [] } : stepKeys(text);
  const clear = !isCheck && /\b(clear|empty)\b/i.test(text.replace(/["“][^"”]*["”]/g, ""));
  return {
    label: label(text, table, docString, header),
    rows: table && !isCheck ? tableSteps(text, table, header) : [text],
    quoted: quotedText,
    values: list ? [...withDoc, ...table.map(r => r[0])] : withDoc,
    candidates: [...new Set([...quotedText, ...numbers, ...clear ? [""] : []]), ...docString === undefined ? [] : [docString]],
    keys,
    unknownKeys: unknown,
    pressOnly: isCheck ? undefined : pressOnly(text),
    navigation: isCheck ? undefined : navigation(text),
    toggle: isCheck ? undefined : toggleGoal(text),
    upload: !isCheck && quotedText.length > 0 && /\b(upload|attach)/i.test(text),
    exact: /\b(exactly|in this order)\b/i.test(text),
    header,
    list,
    placeholders: [...withDoc, ...table?.flat() ?? []].filter(v => placeholder(v)),
    badCell: isCheck ? undefined : table?.flat().find(c => !c.trim() || /["“”]/.test(c)),
  };
}

/** "try"/"attempt" right after the keyword marks an Attempt step: done once performed, even if the app rejects it. */
const ATTEMPT = /^(I\s+)?(try|tries|attempt|attempts)\b/i;

export const stepKind = (step: { text: string; type?: PickleStepType }): StepKind =>
  step.type === PickleStepType.OUTCOME ? "assertion" : ATTEMPT.test(step.text) ? "attempt" : "action";

/** A quoted `"$NAME"` is a secret placeholder (task 0030): the variable's name, else undefined. */
export const placeholder = (value: string) => /^\$([A-Za-z_]\w*)$/.exec(value)?.[1];

const quoted = (text: string): string[] => [...text.matchAll(/["“]([^"”]+)["”]/g)].map(m => m[1]);

function label(text: string, table: string[][] | undefined, docString: string | undefined, header: boolean): string {
  if (docString !== undefined) return `${text} ${JSON.stringify(docString)}`;
  if (!table) return text;
  const cells = header ? table.slice(1).map(row => row.map((v, i) => `${table[0][i]}=${v}`).join(", ")).join("; ")
    : table.map(row => row.length === 1 ? row[0] : `${row[0]}=${row[1]}`).join(", ");
  return `${text} [${cells}]`;
}

/** An Action step's table as one Step per row, each resolved alone; 2 columns are label/value pairs (Cucumber `rowsHash`). */
function tableSteps(text: string, table: string[][], header: boolean): string[] {
  const base = text.replace(/\s*:$/, "");
  if (header) return table.slice(1).map(row => `${base} ${row.map((v, i) => `${table[0][i]} "${v}"`).join(", ")}`);
  return table.map(row => row.length === 1 ? `${base} "${row[0]}"` : `I enter "${row[1]}" as ${row[0]}`);
}

/**
 * Jev's `done` barely tells checked from unchecked (task 0033: 0.45-0.80 on checked boxes, so it kept clicking), so
 * code reads the box after the click instead, like the TYPE/SELECT effect check.
 */
function toggleGoal(text: string): boolean | undefined {
  if (/\b(and|then)\b|,/i.test(text)) return undefined;
  if (/^(I\s+)?(uncheck|untick|deselect|clear|turn off|switch off|disable)\b/i.test(text)) return false;
  // Task 0043: other wordings mean on unless negated; only applied when the clicked element is a toggle or radio.
  return !/\b(disable|turn off|switch off|decline|reject|opt out|unsubscribe)/i.test(text);
}

/** Key names a Step can press (task 0039): Playwright's, lower-cased, plus aliases. */
const KEYS = new Map<string, string>([
  ..."Escape Tab Enter Backspace Delete Insert Home End PageUp PageDown ArrowUp ArrowDown ArrowLeft ArrowRight Space Control Shift Alt Meta"
    .split(" "), ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)].map(k => [k.toLowerCase(), k]));
for (const [alias, key] of Object.entries({ esc: "Escape", return: "Enter", del: "Delete", ctrl: "Control", cmd: "Meta", command: "Meta",
  option: "Alt", "page up": "PageUp", "page down": "PageDown", "up arrow": "ArrowUp", "down arrow": "ArrowDown",
  "left arrow": "ArrowLeft", "right arrow": "ArrowRight", "arrow up": "ArrowUp", "arrow down": "ArrowDown",
  "arrow left": "ArrowLeft", "arrow right": "ArrowRight" })) KEYS.set(alias, key);

/** `Ctrl+K`, `down arrow` -> Playwright's `Control+K`, `ArrowDown`; undefined if a part is no key. A letter or digit alone only quoted. */
function keyName(expr: string, quoted: boolean): string | undefined {
  const parts = expr.trim().split(/\s*\+\s*/);
  const named = parts.map(p => KEYS.get(p.toLowerCase()) ?? (/^[a-z0-9]$/i.test(p) && (quoted || parts.length > 1) ? p : undefined));
  return named.every(k => k !== undefined) ? named.join("+") : undefined;
}

const ELEMENT_NOUN = /^(button|link|tab|icon|item|option|menu|card|row|toggle|checkbox|control)s?$/i;
const PRESS = /\b(?:press(?:es|ed|ing)?|hit(?:s|ting)?)\s+(?:the\s+)?(?:["“]([^"”]+)["”]|([\w+]+(?:\s*\+\s*\w+)*)(?=((?:\s+\w+){0,2})))/gi; // the words after: lookahead, so a next "press" is still found

function stepKeys(text: string): { keys: string[]; unknown: string[] } {
  const keys: string[] = [], unknown: string[] = [];
  // Quoted text (a value to type, a doc string) names no key, unless it is the quoted key itself: press "Tab".
  const said = text.replace(/(\b(?:press(?:es|ed|ing)?|hit(?:s|ting)?)\s+(?:the\s+)?["“][^"”]+["”])|["“][^"”]*["”]/gi, (m, key?: string) => key ?? '""');
  for (const [, quotedKey, first, rest] of said.matchAll(PRESS)) {
    const [next = ""] = rest?.trim().split(/\s+/) ?? [];
    // "press the Delete button" clicks a button named like a key.
    const key = quotedKey !== undefined ? keyName(quotedKey, true)
      : keyName(`${first} ${next}`, false) ?? (ELEMENT_NOUN.test(next) ? undefined : keyName(first, false));
    if (key) keys.push(key);
    else if (first && (first.includes("+") || next.toLowerCase() === "key")) unknown.push(first);
  }
  return { keys, unknown };
}

export interface Navigation { verb: "GOTO" | "BACK" | "FORWARD" | "RELOAD" | "CLOSE_TAB" | "SWITCH_TAB"; value?: string }

/**
 * Code navigates without Jev only for these whole-Step forms; "go back to the list" and the like are left to Jev, which
 * is offered back/forward/reload every Turn. GOTO needs something URL-like (a path, query, hash, or full URL), never a
 * page name: "I go to the Settings page" is Jev's.
 */
function navigation(text: string): Navigation | undefined {
  const t = text.trim().replace(/[.!]$/, "");
  const go = /^(?:I\s+)?(?:go|goes|navigate|navigates|browse|browses)\s+/i.source;
  if (new RegExp(`${go}back$`, "i").test(t)) return { verb: "BACK" };
  if (new RegExp(`${go}forward$`, "i").test(t)) return { verb: "FORWARD" };
  if (/^(?:I\s+)?(?:reload|reloads|refresh|refreshes)(?:\s+the)?(?:\s+page)?$/i.test(t)) return { verb: "RELOAD" };
  // Jev picks "close tab" right (0.97) but then barely takes the Step as done (0.24-0.37): a closed tab leaves no trace.
  if (/^(?:I\s+)?(?:close|closes)\s+(?:the|this)\s+(?:new\s+)?tab$/i.test(t)) return { verb: "CLOSE_TAB" };
  if (/^(?:I\s+)?(?:switch|switches|go|goes)\s+back\s+to\s+the\s+(?:previous|first|other|original)\s+tab$/i.test(t)) return { verb: "SWITCH_TAB" };
  const m = new RegExp(`(?:${go}to|^(?:I\\s+)?(?:open|opens|visit|visits))\\s+(?:["“]([^"”]+)["”]|(\\S+))$`, "i").exec(t);
  const url = m?.[1] ?? m?.[2];
  return url && /^(\/|\?|#|\.\.?\/|[a-z][a-z\d+.-]*:\/\/)/i.test(url) ? { verb: "GOTO", value: url } : undefined;
}

function pressOnly(text: string): string | undefined {
  const m = /^(?:I\s+)?(?:press|hit)(?:es|s)?\s+(?:the\s+)?(?:["“]([^"”]+)["”]|(.+?))(?:\s+key)?[.!]?$/i.exec(text.trim());
  return m ? keyName(m[1] ?? m[2], m[1] !== undefined) : undefined;
}
