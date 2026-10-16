// Parses Playwright's `ariaSnapshot({ mode: "ai" })` text into an Observation.

export type Verb = "CLICK" | "TYPE" | "SELECT";

export interface Element {
  ref: string;
  role: string;
  name: string;
  value: string;
  state: string; // e.g. "[checked] [expanded]"
  secret: boolean; // password field: value never leaves the runtime
  line: string; // compact one-line description shown to Jev
  verb: Verb;
  options: string[]; // native <select> options (they carry no refs)
}

export interface Observation {
  text: string; // filtered snapshot, the state Jev reads
  elements: Element[]; // actionable candidates only
  readable: Element[]; // every ref'd node with text, for Assertion steps
}

const ACTIONABLE = new Set([
  "button", "link", "textbox", "searchbox", "spinbutton", "combobox", "option",
  "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem",
]);
const TYPEABLE = new Set(["textbox", "searchbox", "spinbutton"]);

const LINE = /^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)(?::\s*(.*))?$/;

export const MASK = "\u2022\u2022\u2022\u2022";

/** `secretRefs`: refs of password fields (the snapshot itself shows them as plain textboxes with their value). */
export function parseSnapshot(snapshot: string, secretRefs: ReadonlySet<string> = new Set()): Observation {
  const elements: Element[] = [];
  const readable: Element[] = [];
  const kept: string[] = [];
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
    kept.push(secret && rest ? `${indent}- ${role}${name ? ` "${name}"` : ""}${attrs}: ${MASK}` : raw);

    if (!ref || !(ACTIONABLE.has(role) || name || value)) continue;
    const state = attrs.replace(/\s*\[ref=\w+\]/, "").trim();
    const el: Element = {
      ref, role, name, value, state, secret,
      line: "", // set below, once native select options have filled in the value
      // shortcut: editable (autocomplete) comboboxes get CLICK, not TYPE; detect via DOM when a real app needs it.
      verb: TYPEABLE.has(role) ? "TYPE" : "CLICK",
      options: [],
    };
    readable.push(el);
    if (ACTIONABLE.has(role) && !/\[disabled\]/.test(attrs)) elements.push(el);
    lastCombobox = role === "combobox" ? { el, indent: indent.length } : undefined;
  }
  for (const el of readable) {
    if (el.options.length) el.verb = "SELECT";
    el.line = `${el.role}${el.name ? ` "${el.name}"` : ""}${el.value ? ` value="${el.value}"` : ""}${el.state ? " " + el.state : ""}`;
  }
  return { text: kept.join("\n"), elements, readable };
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
 */
export function assertableText(el: Element): string | undefined {
  if (TYPEABLE.has(el.role) || el.role === "combobox") return el.value;
  if (ACTIONABLE.has(el.role)) return el.value || undefined;
  return el.value || el.name;
}
