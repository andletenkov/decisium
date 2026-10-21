// Parses Playwright's `ariaSnapshot({ mode: "ai" })` text into an Observation.

export type Verb = "CLICK" | "TYPE" | "SELECT";

export interface Element {
  ref: string;
  role: string;
  name: string;
  value: string;
  state: string; // e.g. "[checked] [expanded]"
  secret: boolean; // password field: the value the page shows is masked (not the value quoted in the Step)
  line: string; // compact one-line description shown to Jev
  verb: Verb;
  options: string[]; // native <select> options (they carry no refs)
  text: string; // own name/value plus every descendant's, for scoped presence checks
}

export interface Observation {
  text: string; // filtered snapshot, the state Jev reads
  elements: Element[]; // actionable candidates only
  readable: Element[]; // every ref'd node with text, for Assertion steps
  areas: Element[]; // ref'd nodes with children (lists, tables, regions): where a presence check can look
  pageText: string; // all visible names and values
}

const ACTIONABLE = new Set([
  "button", "link", "textbox", "searchbox", "spinbutton", "combobox", "option",
  "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem",
]);
const TYPEABLE = new Set(["textbox", "searchbox", "spinbutton"]);

const LINE = /^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)(?::\s*(.*))?$/;

export const MASK = "\u2022\u2022\u2022\u2022";

/**
 * `secretRefs`: refs of password fields (the snapshot itself shows them as plain textboxes with their value).
 * `editableRefs`: comboboxes you type into (search boxes with suggestions); other comboboxes are clicked open.
 */
export function parseSnapshot(snapshot: string, secretRefs: ReadonlySet<string> = new Set(), editableRefs: ReadonlySet<string> = new Set()): Observation {
  const elements: Element[] = [];
  const readable: Element[] = [];
  const kept: string[] = [];
  const areas = new Set<Element>();
  const open: { el: Element; indent: number }[] = []; // ancestors of the current line, by indentation
  let pageText = "";
  let lastCombobox: { el: Element; indent: number } | undefined;

  for (const raw of snapshot.split("\n")) {
    const m = LINE.exec(raw);
    if (!m) { if (raw.trim()) kept.push(raw); continue; }
    const [, indent, role, name = "", attrs = "", rest = ""] = m;
    const ref = /\[ref=(\w+)\]/.exec(attrs)?.[1];
    const secret = ref !== undefined && secretRefs.has(ref);
    const value = secret && rest ? MASK : rest.replace(/^"(.*)"$/, "$1");

    // Option children of a native select: no ref, attach to the parent combobox.
    if (role === "option" && !ref && lastCombobox && indent.length > lastCombobox.indent) {
      lastCombobox.el.options.push(name);
      if (/\[selected\]/.test(attrs)) lastCombobox.el.value = name;
      kept.push(raw);
      continue;
    }
    // Drop nameless structural wrappers; keep their children.
    if (role === "generic" && !name && !value) continue;
    while (open.length && open.at(-1)!.indent >= indent.length) open.pop();
    const words = [name, value].filter(Boolean).join(" ");
    pageText += words + "\n";
    for (const o of open) { o.el.text += " " + words; areas.add(o.el); }
    kept.push(secret && rest ? `${indent}- ${role}${name ? ` "${name}"` : ""}${attrs}: ${MASK}` : raw);

    if (!ref) continue;
    const state = attrs.replace(/\s*\[ref=\w+\]/, "").trim();
    const el: Element = {
      ref, role, name, value, state, secret,
      line: "", // set below, once native select options have filled in the value
      verb: TYPEABLE.has(role) || editableRefs.has(ref) ? "TYPE" : "CLICK",
      options: [],
      text: words,
    };
    open.push({ el, indent: indent.length });
    if (!(ACTIONABLE.has(role) || name || value)) continue;
    readable.push(el);
    if (ACTIONABLE.has(role) && !/\[disabled\]/.test(attrs)) elements.push(el);
    lastCombobox = role === "combobox" ? { el, indent: indent.length } : undefined;
  }
  for (const el of [...readable, ...areas]) {
    if (el.options.length) el.verb = "SELECT";
    // A long value (a whole file in a code view) would bury the description; the full value stays in `value` and `ui`.
    const value = el.value.length > 60 ? el.value.slice(0, 60) + "…" : el.value;
    el.line = `${el.role}${el.name ? ` "${el.name}"` : ""}${value ? ` value="${value}"` : ""}${el.state ? " " + el.state : ""}`;
  }
  return { text: kept.join("\n"), elements, readable, areas: [...areas], pageText };
}

/** Double-quoted strings in a Step. Single quotes are left alone so apostrophes ("campaign's") don't open a quote. */
export const quoted = (step: string): string[] => [...step.matchAll(/["“]([^"”]+)["”]/g)].map(m => m[1]);

/** Candidate values a Step can supply: quoted strings and numbers with an optional unit word. */
export function stepValues(step: string): string[] {
  const numbers = [...step.matchAll(/\b\d+(?:[.,]\d+)?(?:\s+[a-z]+)?/gi)].map(m => m[0]);
  return [...new Set([...quoted(step), ...numbers])];
}

/**
 * Text an Assertion step compares against, or undefined when the element's text is only its label.
 * Value-bearing controls compare their value (empty counts); other controls (buttons, checkboxes) only
 * have a name, so "the 'Schedule' button should be disabled" must not pass just because the name matches.
 * Links are the exception: their text is content (a breadcrumb or title showing a name), like a heading's.
 */
export function assertableText(el: Element): string | undefined {
  if (TYPEABLE.has(el.role) || el.role === "combobox") return el.value;
  if (ACTIONABLE.has(el.role) && el.role !== "link") return el.value || undefined; // a link's text is what it shows
  return el.value || el.name;
}
