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
  parent?: Element; // nearest ref'd ancestor
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

/** Longest `ui` line Jev reads (citation blobs, inline code); the full text stays in `value` and `pageText` (task 0021). */
const MAX_LINE = 200;
const cap = (line: string) => line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line;

/**
 * `secretRefs`: refs of password fields (the snapshot itself shows them as plain textboxes with their value).
 * `editableRefs`: comboboxes you type into (search boxes with suggestions); other comboboxes are clicked open.
 */
export function parseSnapshot(snapshot: string, secretRefs: ReadonlySet<string> = new Set(), editableRefs: ReadonlySet<string> = new Set()): Observation {
  const elements: Element[] = [];
  const readable: Element[] = [];
  const kept: (string | undefined)[] = [];
  const areas = new Set<Element>();
  const open: { el: Element; indent: number }[] = []; // ancestors of the current line, by indentation
  const bare = new Map<Element, string[]>(); // container -> text it holds that has no element of its own
  const named = new Map<Element, string[]>(); // container -> names of the ref'd elements inside it
  const wrappers = new Map<Element, number>(); // nameless container -> its line in `kept`, dropped unless it holds text
  let pageText = "";
  let lastCombobox: { el: Element; indent: number } | undefined;

  for (let raw of snapshot.split("\n")) {
    // The snapshot marks only checked boxes. Without a mark for the other state, Jev never read "uncheck X" as done
    // (task 0031: 8 clicks, then STEP_TIMEOUT).
    if (/^\s*- (checkbox|radio|switch|menuitemcheckbox|menuitemradio)\b/.test(raw) && !/\[checked/.test(raw)) raw = raw.replace(" [ref=", " [unchecked] [ref=");
    const m = LINE.exec(raw);
    // `/url` lines repeat what the link's name already says; browser.ts reads urls from the raw snapshot.
    if (!m) { if (raw.trim() && !/^\s*- \/url:/.test(raw)) kept.push(cap(raw)); continue; }
    const [, indent, role, name = "", attrs = "", rest = ""] = m;
    const ref = /\[ref=(\w+)\]/.exec(attrs)?.[1];
    const secret = ref !== undefined && secretRefs.has(ref);
    const value = secret && rest ? MASK : rest.replace(/^"(.*)"$/, "$1");

    // Option children of a native select: no ref, attach to the parent combobox.
    if (role === "option" && !ref && lastCombobox && indent.length > lastCombobox.indent) {
      lastCombobox.el.options.push(name);
      if (/\[selected\]/.test(attrs)) lastCombobox.el.value = name;
      kept.push(cap(raw));
      continue;
    }
    // Drop nameless structural wrappers that cannot hold anything readable; the ref'd ones are decided below.
    if (role === "generic" && !name && !value && !ref) continue;
    while (open.length && open.at(-1)!.indent >= indent.length) open.pop();
    const words = [name, value].filter(Boolean).join(" ");
    pageText += words + "\n";
    for (const o of open) {
      o.el.text += " " + words;
      areas.add(o.el);
      if (ref && name) named.set(o.el, [...(named.get(o.el) ?? []), name]);
    }
    const at = kept.push(secret && rest ? `${indent}- ${role}${name ? ` "${name}"` : ""}${attrs}: ${MASK}` : cap(raw)) - 1;

    // Text with no element of its own (a bare `- text:` line, or text split across children): the nearest ref'd
    // container is the only thing a check can read it from, so that container becomes readable (task 0006).
    const host = open.at(-1)?.el;
    if (!ref) {
      if (words && host) bare.set(host, [...(bare.get(host) ?? []), words]);
      continue;
    }
    const state = attrs.replace(/\s*\[ref=\w+\]/, "").trim();
    const el: Element = {
      ref, role, name, value, state, secret,
      line: "", // set below, once native select options have filled in the value
      verb: TYPEABLE.has(role) || editableRefs.has(ref) ? "TYPE" : "CLICK",
      options: [],
      text: words,
      parent: host,
    };
    open.push({ el, indent: indent.length });
    if (role === "generic" && !name && !value) wrappers.set(el, at);
    if (!(ACTIONABLE.has(role) || name || value)) continue;
    readable.push(el);
    if (ACTIONABLE.has(role) && !/\[disabled\]/.test(attrs)) elements.push(el);
    lastCombobox = role === "combobox" ? { el, indent: indent.length } : undefined;
  }
  for (const [el, texts] of bare) {
    // Text that only names a control inside the container (a field's label) adds nothing a check can read.
    if (texts.every(t => named.get(el)?.includes(t))) continue;
    el.value = el.text.trim(); // a check compares the container's full text, own and descendants'
    if (!readable.includes(el)) readable.push(el);
    wrappers.delete(el); // Jev must see its line to pick it
  }
  for (const at of wrappers.values()) kept[at] = undefined;
  for (const el of [...readable, ...areas]) {
    if (el.options.length) el.verb = "SELECT";
    // A long value (a whole file in a code view) would bury the description; the full value stays in `value`.
    const value = el.value.length > 60 ? el.value.slice(0, 60) + "…" : el.value;
    el.line = `${el.role}${el.name ? ` "${el.name}"` : ""}${value ? ` value="${value}"` : ""}${el.state ? " " + el.state : ""}`;
  }
  return { text: kept.filter(l => l !== undefined).join("\n"), elements, readable, areas: [...areas], pageText };
}

/** Double-quoted strings in a Step. Single quotes are left alone so apostrophes ("campaign's") don't open a quote. */
export const quoted = (step: string): string[] => [...step.matchAll(/["“]([^"”]+)["”]/g)].map(m => m[1]);

/** A quoted `"$NAME"` is a secret placeholder (task 0030): the variable's name, else undefined. */
export const placeholder = (value: string) => /^\$([A-Za-z_]\w*)$/.exec(value)?.[1];

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

/**
 * Adds the page URL and title as two readable pseudo-elements (refs `url`, `title`) on top of `ui`, so a value check
 * can pick them as the subject (task 0025). Not actionable, and not in `pageText`: text only in the URL is not shown.
 */
export function withPage(obs: Observation, url: string, title: string): Observation {
  const page = ([["url", url], ["title", title]] as const).map(([role, value]): Element => ({
    ref: role, role, name: "", value, state: "", secret: false, verb: "CLICK", options: [], text: value,
    line: `${role} value="${value.length > 60 ? value.slice(0, 60) + "…" : value}"`,
  }));
  const top = page.map(e => cap(`- ${e.role}: ${e.value}`)).join("\n");
  return { ...obs, text: obs.text ? `${top}\n${obs.text}` : top, readable: [...page, ...obs.readable] };
}
