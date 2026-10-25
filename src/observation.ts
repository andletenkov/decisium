// Renders Playwright's `ariaSnapshotJSON({ mode: "ai" })` as compact text and parses that into an Observation.

/** A node of `ariaSnapshotJSON`: free-form, states as extra keys (`checked`, `level`, ...); text nodes are strings. */
export type AriaNode = string | { role: string; name?: string; ref?: string; cursor?: string; url?: string; text?: string; children?: AriaNode[]; [state: string]: unknown };

const KEYS = new Set(["role", "name", "ref", "cursor", "url", "text", "children", "box"]);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The snapshot's text form, one line per node, without YAML quoting: the YAML text quoted lines whose name held a colon
 * (`- 'heading "Releases: x/y" [ref=e1]'`) and the line parser dropped them (task 0064). Names escape `\` and `"`.
 */
export function renderSnapshot(nodes: AriaNode[], indent = ""): string {
  return nodes.map(n => {
    if (typeof n === "string") return `${indent}- text: ${oneLine(n)}`;
    const states = Object.entries(n).filter(([k, v]) => !KEYS.has(k) && v !== false && v !== undefined)
      .map(([k, v]) => v === true ? ` [${k}]` : ` [${k}=${v}]`).join("");
    const head = `${indent}- ${n.role}${n.name ? ` "${n.name.replace(/[\\"]/g, "\\$&")}"` : ""}${states}${n.ref ? ` [ref=${n.ref}]` : ""}${n.cursor ? ` [cursor=${n.cursor}]` : ""}`;
    const kids = [...n.url !== undefined ? [`${indent}  - /url: ${n.url}`] : [], ...n.children?.length && n.text ? [`${indent}  - text: ${oneLine(n.text)}`] : [],
      ...n.children?.length ? [renderSnapshot(n.children, indent + "  ")] : []];
    if (kids.length) return `${head}:\n${kids.join("\n")}`;
    return n.text ? `${head}: ${oneLine(n.text)}` : head;
  }).join("\n");
}

export type Verb = "CLICK" | "TYPE" | "SELECT";

export interface Element {
  ref: string;
  role: string;
  name: string;
  value: string;
  description?: string; // its `title` attribute, when that says more than the name (task 0042)
  state: string; // e.g. "[checked] [expanded]"
  secret: boolean; // password field: the value the page shows is masked (not the value quoted in the Step)
  line: string; // compact one-line description shown to Jev
  verb: Verb;
  options: string[]; // native <select> options (they carry no refs)
  text: string; // own name/value plus every descendant's, for scoped presence checks
  parent?: Element; // nearest ref'd ancestor
  cells?: Element[]; // a table row's cells in order, empty ones included
  url?: string; // a link's target: equivalent links are grouped (task 0065)
}

export interface Observation {
  text: string; // filtered snapshot, the state Jev reads
  elements: Element[]; // actionable candidates only
  readable: Element[]; // every ref'd node with text, for Assertion steps
  areas: Element[]; // ref'd nodes with children (lists, tables, regions): where a presence check can look
  pageText: string; // all visible names and values
  dialog?: Dialog; // a browser dialog, open or the last one shown (task 0040)
}

/** A browser dialog: open, or the last one shown, readable until the next action Step (task 0040). */
export interface Dialog { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; state: "open" | "accepted" | "dismissed" }

const ACTIONABLE = new Set([
  "button", "link", "textbox", "searchbox", "spinbutton", "combobox", "option",
  "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "slider",
]);
const CELLS = new Set(["cell", "gridcell", "columnheader", "rowheader"]);
const TYPEABLE = new Set(["textbox", "searchbox", "spinbutton", "slider"]); // slider: fill sets a range input (task 0045)

const LINE = /^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)(?::\s*(.*))?$/;

export const MASK = "\u2022\u2022\u2022\u2022";

/** Longest `ui` line Jev reads (citation blobs, inline code); the full text stays in `value` and `pageText` (task 0021). */
const MAX_LINE = 200;
const cap = (line: string) => line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line;

/**
 * `secretRefs`: refs of password fields (the snapshot itself shows them as plain textboxes with their value).
 * `editableRefs`: comboboxes you type into (search boxes with suggestions); other comboboxes are clicked open.
 * `targetRefs`: non-controls with their own pointer cursor or tabindex: Turn targets (task 0064).
 */
export function parseSnapshot(snapshot: string, secretRefs: ReadonlySet<string> = new Set(), editableRefs: ReadonlySet<string> = new Set(),
  targetRefs: ReadonlySet<string> = new Set()): Observation {
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
    // `/url` lines repeat what the link's name already says: kept on the link, not in `ui`.
    const url = /^\s*- \/url: (.*)$/.exec(raw)?.[1];
    if (url !== undefined) { const link = open.at(-1)?.el; if (link?.role === "link") link.url = url.replace(/^"(.*)"$/, "$1"); continue; }
    if (!m) { if (raw.trim()) kept.push(cap(raw)); continue; }
    const [, indent, role, name = "", attrs = "", rest = ""] = m;
    const ref = /\[ref=(\w+)\]/.exec(attrs)?.[1];
    const secret = ref !== undefined && secretRefs.has(ref);
    const value = secret && rest ? MASK : rest;

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
    const description = /\[description="([^"]*)"\]/.exec(attrs)?.[1];
    const state = attrs.replace(/\s*\[ref=\w+\]/, "").replace(/\s*\[description="[^"]*"\]/, "").trim();
    const el: Element = {
      ref, role, name, value, description, state, secret,
      line: "", // set below, once native select options have filled in the value
      verb: TYPEABLE.has(role) || editableRefs.has(ref) ? "TYPE" : "CLICK",
      options: [],
      text: words,
      parent: host,
    };
    open.push({ el, indent: indent.length });
    if (host?.role === "row" && CELLS.has(role)) (host.cells ??= []).push(el);
    const scrollable = /\[scrollable\]/.test(attrs);
    if (role === "generic" && !name && !value && !scrollable) wrappers.set(el, at);
    if (!(ACTIONABLE.has(role) || name || value || scrollable)) continue;
    readable.push(el);
    // Draggable: a drag target (task 0045); scrollable: a scroll target (task 0061); own pointer cursor or tabindex:
    // a custom control (task 0064; an inherited pointer cursor proves nothing). Column headers: often sort on click
    // with no sign in the DOM but a click listener (the-internet); a CDP listener lookup found only that case.
    if ((ACTIONABLE.has(role) || role === "columnheader" || targetRefs.has(ref) || /\[draggable\]|\[scrollable\]/.test(attrs)) && !/\[disabled\]/.test(attrs)) elements.push(el);
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
    const value = clip(el.value);
    el.line = `${el.role}${el.name ? ` "${el.name}"` : ""}${value ? ` value="${value}"` : ""}${el.description ? ` description="${el.description}"` : ""}${el.state ? " " + el.state : ""}`;
  }
  return { text: kept.filter(l => l !== undefined).join("\n"), elements, readable, areas: [...areas], pageText };
}

/** A value cut to 60 characters for an element's line. */
const clip = (value: string) => value.length > 60 ? value.slice(0, 60) + "…" : value;

/**
 * Text an Assertion step compares against, or undefined when the element's text is only its label.
 * Value-bearing controls compare their value (empty counts); other controls (buttons, checkboxes) only
 * have a name, so "the 'Schedule' button should be disabled" must not pass just because the name matches.
 * Links are the exception: their text is content (a breadcrumb or title showing a name), like a heading's.
 */
export function assertableText(el: Element): string | undefined {
  if (TYPEABLE.has(el.role) || el.role === "combobox") return el.value;
  if (ACTIONABLE.has(el.role) && el.role !== "link") return el.value || el.description || undefined; // a link's text is what it shows
  return el.value || el.name;
}

/**
 * Adds the page URL and title as two readable pseudo-elements (refs `url`, `title`) on top of `ui`, so a value check
 * can pick them as the subject (task 0025). Not actionable, and not in `pageText`: text only in the URL is not shown.
 * `tabs` (task 0041): e.g. "2 open, this is tab 2", only while more than one is open, so one-tab pages read as before.
 */
export function withPage(obs: Observation, url: string, title: string, tabs?: string): Observation {
  const fields: [string, string][] = [["url", url], ["title", title], ...tabs ? [["tabs", tabs] as [string, string]] : []];
  const page = fields.map(([role, value]): Element => ({
    ref: role, role, name: "", value, state: "", secret: false, verb: "CLICK", options: [], text: value,
    line: `${role} value="${clip(value)}"`,
  }));
  // The page as a target (task 0065): its line is what Jev compares "scroll up the Chat" with the Chat panel against.
  const top = [cap(`- page "${title}" [ref=page]`), ...page.map(e => cap(`- ${e.role}: ${e.value}`))].join("\n");
  return { ...obs, text: obs.text ? `${top}\n${obs.text}` : top, readable: [...page, ...obs.readable] };
}

/**
 * Adds a browser dialog as a readable pseudo-element (ref `dialog`) on top of `ui`, named "browser dialog" so it is not
 * taken for an ARIA alert, with its state (open, accepted, dismissed: Jev read a check about the page after a closed
 * "Delete the Ideas note?" as an absence check). Its message is information for Jev and what a value check compares,
 * never something to click. Like the URL it is not an area or page text: a check about the page must not read it.
 */
export function withDialog(obs: Observation, dialog?: Dialog): Observation {
  if (!dialog) return obs;
  const { type, message, state } = dialog;
  const el: Element = {
    ref: "dialog", role: type, name: "browser dialog", value: message, state: `[${state}]`, secret: false, verb: "CLICK", options: [],
    text: message, line: `${type} "browser dialog" value="${clip(message)}" [${state}]`,
  };
  const top = cap(`- ${type} "browser dialog" [${state}]: ${message}`);
  return { ...obs, dialog, text: obs.text ? `${top}\n${obs.text}` : top, readable: [el, ...obs.readable] };
}

/** The last download of the scenario (task 0044), saved to its run folder. `text`: its contents, unless binary. */
export interface Download { name: string; size: number; text?: string }

/**
 * Adds the last download as a readable pseudo-element (ref `download`): its value is the file name and, for a text file,
 * its contents, so the value check compares either. An empty file is `[empty]`, and a value check on it fails.
 */
export function withDownload(obs: Observation, download?: Download): Observation {
  if (!download) return obs;
  const { name, size, text } = download;
  const value = text ? `${name}\n${text}` : name;
  const state = size ? `[${size} bytes]` : "[empty]";
  const el: Element = {
    ref: "download", role: "download", name: "downloaded file", value, state, secret: false, verb: "CLICK", options: [],
    text: value, line: `download "downloaded file" value="${clip(value.replace(/\s+/g, " "))}" ${state}`,
  };
  const top = cap(`- download "downloaded file" ${state}: ${value.replace(/\s+/g, " ")}`);
  return { ...obs, text: obs.text ? `${top}\n${obs.text}` : top, readable: [el, ...obs.readable] };
}

/** Adds the clipboard text (task 0062) as a readable pseudo-element (ref `clipboard`), so a value check reads copied text. */
export function withClipboard(obs: Observation, text?: string): Observation {
  if (!text) return obs;
  const el: Element = {
    ref: "clipboard", role: "clipboard", name: "copied text", value: text, state: "", secret: false, verb: "CLICK", options: [],
    text, line: `clipboard "copied text" value="${clip(text.replace(/\s+/g, " "))}"`,
  };
  const top = cap(`- clipboard "copied text": ${text.replace(/\s+/g, " ")}`);
  return { ...obs, text: obs.text ? `${top}\n${obs.text}` : top, readable: [el, ...obs.readable] };
}
