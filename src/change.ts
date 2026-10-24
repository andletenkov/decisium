// What an action changed on the page, for Jev's `actions_taken_for_step` (task 0066): Jev never saw the effect of its
// action and stayed under-confident after working ones (the-internet sort: done 0.30 -> 0.86-0.92 with this evidence).
import type { Element, Observation } from "./observation.ts";

const MAX = 300;
const PAGE = new Set(["url", "title", "tabs", "dialog", "download", "clipboard"]);
const ITEMS = 5;
/** Icon-font glyphs (private use) and zero-width characters print as nothing: `value "" -> ""` (OrangeHRM). */
const clean = (s: string) => s.replace(/[\u200b-\u200d\ufeff\ue000-\uf8ff]/g, "").replace(/\s+/g, " ").trim();
const short = (s: string, n = 40) => (s.length > n ? s.slice(0, n) + "…" : s);
/** Containers (nodes with children): their value is their descendants' text, so it does not tell them apart. */
const containers = new WeakSet<Element>();
/** What tells a node apart: its name, or for a nameless one (a list item) its text. */
const ident = (e: Element) => clean(e.name) || (e.secret || containers.has(e) ? "" : clean(e.value));
const label = (e: Element) => `${e.role}${ident(e) ? ` "${short(ident(e))}"` : ""}`;
const where = (e: Element) => { let p = e.parent; while (p && !p.name) p = p.parent; return p ? label(p) : "the page"; };
/** Two long texts shown around where they first differ, so a clipped "A…" -> "A…" still says what changed. */
function values(a: string, b: string) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 15);
  const cut = (s: string) => `"${from ? "…" : ""}${short(s.slice(from), 40)}"`;
  return `${cut(a)} -> ${cut(b)}`;
}
/** States that flip with focus and hover, not with what an action did. */
const state = (e: Element) => e.state.replace(/\s*\[(cursor=\w+|active)\]/g, "").trim();

/** Nearest named ancestor: refs change between Observations, so nodes are matched by role, name and this. */
const anc = (e: Element) => { let p = e.parent; while (p && !p.name) p = p.parent; return p ? `${p.role}|${p.name}` : ""; };

/** Every node of `obs` once, in snapshot order (readable first: it holds the page pseudo-elements). */
const all = (obs: Observation) => [...new Set([...obs.readable, ...obs.elements, ...obs.areas])];
/** Nodes that can be told apart: unnamed, valueless wrappers only match by position and churn when a menu opens. */
const told = (e: Element) => !!(clean(e.name) || clean(e.value)) || e.role === "row" || e.role === "listitem";

/** First text of a list item or table row, for a reorder entry. */
const itemText = (e: Element) => short(e.cells?.[0]?.name || e.cells?.[0]?.value || e.name || e.value || e.text.trim(), 20);

/** Items (direct ref'd children) of each container, by the container's match key; rowgroups hold the rows. */
function sequences(obs: Observation, keyOf: Map<Element, string>) {
  const out = new Map<string, Element[]>();
  for (const e of all(obs)) if (e.parent && (e.role === "row" || e.role === "listitem")) {
    const k = keyOf.get(e.parent)!;
    out.set(k, [...out.get(k) ?? [], e]);
  }
  return out;
}

function keys(obs: Observation) {
  for (const a of obs.areas) containers.add(a);
  const seen = new Map<string, number>();
  const keyOf = new Map<Element, string>();
  for (const e of all(obs)) {
    const base = `${e.role}|${ident(e)}|${anc(e)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    keyOf.set(e, `${base}#${n}`);
  }
  return keyOf;
}

/**
 * The changes from `before` to `after`, nearest to `acted` (the ref acted on in `before`) first, capped at 300
 * characters; "no visible change" when there are none. Both Observations are already masked, so secrets stay masked.
 */
export function changes(before: Observation, after: Observation, acted?: string): string {
  const kb = keys(before), ka = keys(after);
  const byKey = new Map([...kb].map(([e, k]) => [k, e]));
  // `keys`: match keys of the entry's node and its ancestors; `text` of a container: dropped when an entry inside it says more.
  const entries: { at: number; text: string; keys: string[]; container?: string }[] = [];
  const chain = (e: Element, keyOf: Map<Element, string>) => { const out: string[] = []; for (let p: Element | undefined = e; p; p = p.parent) out.push(keyOf.get(p) ?? ""); return out; };
  const order = all(after);
  // The page's own pseudo-elements (url, title, ...) come first: a navigation is the strongest evidence.
  const pos = (e: Element) => (PAGE.has(e.ref) ? -Infinity : order.indexOf(e));
  const matched = new Set<Element>();

  for (const [e, k] of ka) {
    const old = byKey.get(k);
    if (!old || !told(e)) continue;
    matched.add(old);
    const what: string[] = [];
    if (clean(old.value) !== clean(e.value)) what.push(`value ${values(clean(old.value), clean(e.value))}`);
    if (state(old) !== state(e)) what.push(`${state(old) || "[no state]"} -> ${state(e) || "[no state]"}`);
    // A container whose own state did not change only repeats what changed inside it (whole-page text, task 0066).
    const container = containers.has(e) && state(old) === state(e) ? k : undefined;
    if (what.length) entries.push({ at: pos(e), text: `${label(e)} ${what.join(", ")}`, keys: chain(e, ka), container });
  }
  // Unmatched: the same node under another named ancestor moved (a drag between lists); a name change pairs by role,
  // ancestor and position among the unmatched; the rest appeared or went.
  const gone = [...kb.keys()].filter(e => told(e) && !matched.has(e));
  const added = [...ka].filter(([e, k]) => told(e) && !byKey.has(k)).map(([e]) => e);
  for (const e of added) {
    const m = gone.findIndex(o => o.role === e.role && ident(o) === ident(e) && ident(e));
    if (m >= 0) { entries.push({ at: pos(e), text: `${label(e)} moved from ${where(gone.splice(m, 1)[0])} to ${where(e)}`, keys: chain(e, ka) }); continue; }
    const i = gone.findIndex(o => o.role === e.role && anc(o) === anc(e));
    const old = i >= 0 ? gone.splice(i, 1)[0] : undefined;
    entries.push({ at: pos(e), text: !old ? `appeared: ${label(e)}`
      : clean(old.name) || clean(e.name) ? `${label(old)} -> "${short(ident(e))}"` : `${e.role} value ${values(ident(old), ident(e))}`, keys: chain(e, ka) });
  }
  // Placed where they were: a deleted file listed last read as an afterthought (task 0066: done 0.55 -> 0.95 first).
  // The acted-on control and its siblings going away (a menu closing after its item was clicked) go last.
  const old = all(before);
  const acting = old.find(e => e.ref === acted);
  for (const o of gone) entries.push({ at: acting && (o === acting || o.parent === acting.parent) ? Infinity : old.indexOf(o), text: `gone: ${label(o)}`, keys: chain(o, kb), container: containers.has(o) ? kb.get(o) : undefined });

  // Reordered rows or items: same items, other order.
  const sb = sequences(before, kb), sa = sequences(after, ka);
  for (const [k, items] of sa) {
    const was = sb.get(k)?.map(itemText), now = items.map(itemText);
    if (!was || was.join("\n") === now.join("\n") || [...was].sort().join("\n") !== [...now].sort().join("\n")) continue;
    const container = items[0].parent!;
    entries.push({ at: pos(container), text: `${label(container)} reordered: ${was.slice(0, ITEMS).join(", ")} -> ${now.slice(0, ITEMS).join(", ")}`, keys: chain(container, ka) });
  }
  const said = entries.filter(x => !x.container || !entries.some(y => y !== x && y.keys.slice(1).includes(x.container!)));
  entries.splice(0, entries.length, ...said);

  if (!entries.length) return "no visible change";
  // shortcut: gone entries are placed by their index in `before`, the rest by `after`; close enough while most of
  // the page stays, measure if a large insertion reorders entries badly.
  const at = acting ? pos(order.find(e => ka.get(e) === kb.get(acting)) ?? acting) : -1;
  const dist = (x: number) => (x === -Infinity ? -1 : at < 0 ? x : Math.abs(x - at));
  entries.sort((a, b) => dist(a.at) - dist(b.at));
  let out = "";
  for (const { text } of entries) {
    const next = out ? `${out}; ${text}` : text;
    if (next.length > MAX) return `changed: ${out}; …`;
    out = next;
  }
  return `changed: ${out}`;
}
