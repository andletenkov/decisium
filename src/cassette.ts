import { DEFAULTS, settings, type Settings } from "./options.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  capabilities,
  confidence,
  DONE_THRESHOLD,
  goneKey,
  goneResolution,
  NotYet,
  PAGE,
  plausible,
  gate,
  GATE_TARGET_MARGIN,
  type Assessment,
  type Decider,
  type Intent,
  type Pick,
  type TurnAnswer,
} from "./decision.ts";
import { parseSnapshot, within, type Element, type Observation } from "./observation.ts";
import { readStep, type ParsedStep } from "./step.ts";
import { fill } from "./generate.ts";

/** none: replay only, a missing or broken resolution fails. new: replay, resolve missing/broken Steps live. all: always live. */
export type RecordMode = "none" | "new" | "all";
export const RECORD_MODES: RecordMode[] = ["none", "new", "all"];

/**
 * What a Step resolved to (ADR 0002, reopened by task 0032): the element by role, name, its nearest named container,
 * and, when it has same-named peers there, `near`: the text of its closest own-or-ancestor node that no peer shares
 * (the product card "Backpack $29.99 Add to cart"). Before that, `anchor`: a value the Step quotes that only this
 * element's own part of the page shows ("Spring Sale" for `I open the "Spring Sale" campaign`), the reason it was
 * chosen and the most stable thing to find it by. Only twins nothing tells apart fall back to a position (`nth` of
 * `of`): a reorder of them is invisible, but so is any difference between them.
 */
export interface Resolution {
  role: string;
  name: string;
  container: string;
  anchor?: string;
  near?: string;
  nth?: number;
  of?: number;
}
type Target = Resolution | string; // a string: a non-element answer (scroll, wait, enter, none, page, missing)
/**
 * A Jev answer with element refs as Resolutions, covering at least 0.8 so lowering confidence cannot erase a close runner-up:
 * the part the confidence gates and runner.ts read, so replay reaches the same outcome, a failing one included.
 */
type Answer = [Target, number, Settings["confidence"]?][];
type Turn = { done: number; target: Answer; action?: Answer; value?: Answer; drop?: Answer } | { dialog: Answer }; // dialog: a Turn answering a browser dialog
interface Check {
  kind: Pick;
  /** Absent in entries recorded before issue #81: their kinds folded negation in (`absence`), so they are re-recorded. */
  negated?: Pick;
  state: Pick;
  subject: Answer;
  area: Answer;
}
interface Entry {
  confidence?: Settings["confidence"];
  turns?: Turn[];
  check?: Check;
  recall?: Answer;
  pinned?: { turn: number; candidate: number; resolution: Resolution; original: Answer }[];
  intent?: Intent; // already gated (jev.ts); absent in cassettes recorded before issue #31: read by the rules alone
}
interface File {
  model: string;
  run?: string;
  entries: Record<string, Entry>;
} // run: id of the run that last saved it

// Cassette entries carry templates, while the decider and page use the current run's concrete values.
function mapEntry(entry: Entry, transform: (value: string) => string): Entry {
  return JSON.parse(JSON.stringify(entry), (_key, value: unknown) =>
    typeof value === "string" ? transform(value) : value,
  ) as Entry;
}

function templateValue(text: string, generated: Record<string, string>): string {
  const id = generated["{{decisium.runId}}"];
  return id ? text.replaceAll(id, "{{decisium.runId}}") : text;
}

function formatFile(file: File): string {
  const { entries, ...header } = file;
  const properties = JSON.stringify(header, null, 2).slice(2, -2);
  const lines = Object.entries(entries).map(([key, entry]) => `    ${JSON.stringify(key)}: ${JSON.stringify(entry)}`);
  return `{\n${properties},\n  "entries": {${lines.length ? `\n${lines.join(",\n")}\n  ` : ""}}\n}\n`;
}

function singleAction(step: ParsedStep): string | undefined {
  const wording = step.text.replace(/["“][^"”]*["”]/g, "@").trim();
  const match = /^(?:I\s+)?(double-click|right-click|click|hover over|type|fill|select|upload)\b/i.exec(wording);
  const verb = match?.[1].toLowerCase();
  if (!verb || step.kind === "assertion") return;
  // A positive grammar, not a blacklist of conjunctions: unseen continuations must never become DONE.
  const role =
    "(?:button|link|field|textbox|searchbox|combobox|checkbox|radio|tab|item|option|control|slider|spinbutton)";
  const target = `(?:(?:the|a|an)\\s+)?(?:@(?:\\s+${role})?|${role}(?:\\s+@)?)(?:\\s+in\\s+(?:the\\s+)?@(?:\\s+(?:area|section|region|dialog|list))?)?`;
  const forms: Record<string, string> = {
    click: `(?:on\\s+)?${target}`,
    "double-click": `(?:on\\s+)?${target}`,
    "right-click": `(?:on\\s+)?${target}`,
    "hover over": target,
    type: `@\\s+(?:into|in)\\s+${target}`,
    fill: `${target}(?:\\s+with\\s+@)?`,
    select: `@\\s+(?:from|in)\\s+${target}`,
    upload: `@\\s+to\\s+${target}`,
  };
  if (!new RegExp(`^\\s+${forms[verb]}$`, "i").test(wording.slice(match![0].length))) return;
  return (
    (
      { "double-click": "double click", "right-click": "right click", "hover over": "hover", fill: "type" } as Record<
        string,
        string
      >
    )[verb] ?? verb
  );
}

function candidates(entry?: Entry): [Resolution, number][] {
  const t = entry?.turns?.at(-1);
  if (!t || "dialog" in t || t.done >= 0.8) return [];
  // Only element-target uncertainty is pinnable; never override checks or missing values.
  const probabilities = Object.fromEntries(t.target.map(([, p], i) => [String(i), p]));
  if (
    gate(
      { choice: "0", probabilities },
      (t.target[0]?.[2] ?? entry?.confidence ?? DEFAULTS.confidence).target,
      GATE_TARGET_MARGIN,
    )
  )
    return [];
  return t.target.slice(0, 3).filter((a): a is [Resolution, number] => typeof a[0] !== "string");
}

/** Confirms one recorded action target. Other confidence gates and UI matching stay intact. */
export function pin(path: string, key: string, selection: number, step: ParsedStep): Resolution {
  const file: File = JSON.parse(readFileSync(path, "utf8"));
  const entry = file.entries[key];
  const options = candidates(entry);
  const chosen = options[selection - 1];
  if (!Number.isInteger(selection) || selection < 1 || !chosen)
    throw new Error("Choose an available Resolution (1-3) from an AMBIGUOUS action target.");
  const t = entry.turns!.at(-1)!;
  if ("dialog" in t) throw new Error("Cannot pin a dialog.");
  const action = singleAction(step);
  if (!action)
    throw new Error(
      "Pin requires an explicit single action (click, type, fill, select, upload or hover); an unresolved continuation cannot be confirmed offline.",
    );
  const obs = parseSnapshot(`- ${chosen[0].role} ${JSON.stringify(chosen[0].name)} [ref=pin]`);
  const el = obs.elements[0];
  if (!el || !capabilities(el, obs).includes(action))
    throw new Error(`The chosen Resolution cannot perform ${action}. Cassette unchanged.`);
  if (["type", "select", "upload"].includes(action) && !t.value) {
    const supplied = /^(?:I\s+)?fill\b/i.test(step.text)
      ? /\bwith\s+["“]([^"”]*)["”]\s*$/i.exec(step.text)
      : /^(?:I\s+)?(?:type|select|upload)\s+["“]([^"”]*)["”]\s+(?:into|in|from|to)\b/i.exec(step.text);
    if (!supplied)
      throw new Error(
        "This target needs an unrecorded value; use explicit quoted value wording or record the Step instead.",
      );
    t.value = [[supplied[1], 1]];
  }
  t.action = [[action, 1]];
  (entry.pinned ??= []).push({
    turn: entry.turns!.length,
    candidate: selection,
    resolution: chosen[0],
    original: t.target,
  });
  t.target = [[chosen[0], 1]];

  writeFileSync(path + ".tmp", formatFile(file));
  renameSync(path + ".tmp", path);
  return chosen[0];
}

/** Replay-only mode and a Step whose recorded resolution is missing or no longer holds. */
export class UiChanged extends Error {
  reason: string; // for people
  constructor(reason: string) {
    super(`UI_CHANGED: ${reason}`);
    this.reason = reason;
  }
}

/** Nearest ancestor with a name, e.g. `list "Issues"`; "" at the top. */
const containerOf = (el: Element) => {
  for (let p = el.parent; p; p = p.parent) if (p.name) return `${p.role} "${p.name}"`;
  return "";
};
const same = (el: Element, r: Omit<Resolution, "nth" | "of">) =>
  el.role === r.role && el.name === r.name && containerOf(el) === r.container;

const NEAR_MAX = 200; // a longer text is kept as its start and a hash, so the cassette stays readable

/**
 * Values that change from run to run: a date, a time, a duration, how long ago, an amount, a percentage, a generated
 * id. `near` is meant to tell look-alikes apart in the next run too, so these are masked before texts are compared
 * or recorded. Longer patterns first: a date holds a time.
 */
// Whole month names or their abbreviations only: "Marketing 10" or "Juniper 12" are names, not dates.
const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const UNIT = "(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|days?|weeks?|months?|years?)";
// A one-letter unit only when attached ("1.4s", "250ms"): "Size 10 m" is a size, not a duration.
const DURATION = "(?:ms|s|m|h|\\s?(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?|years?))";
const VOLATILE: [RegExp, string][] = [
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?!\d)/g, "‹date›"],
  [/\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g, "‹date›"], // a 4-digit year: "1.2.10" is a version
  [new RegExp(`\\b${MONTH} \\d{1,2}(?:,? \\d{4})?\\b|\\b\\d{1,2} ${MONTH}(?: \\d{4})?\\b`, "gi"), "‹date›"],
  [/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s?[AaPp][Mm])?(?!\d)/g, "‹time›"],
  [new RegExp(`\\b(?:just now|(?:\\d+|an?) ${UNIT} ago|in (?:\\d+|an?) ${UNIT})\\b`, "gi"), "‹time›"],
  [new RegExp(`\\b\\d+(?:[.,]\\d+)?${DURATION}\\b`, "g"), "‹duration›"],
  [/[$€£¥₽]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:USD|EUR|GBP|RUB|tokens?|credits?)\b/g, "‹amount›"],
  [/\b\d+(?:[.,]\d+)?\s?%/g, "‹percent›"],
  // A uuid only: a long number ("Invoice 2024001") is often stable test data that tells rows apart.
  [/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "‹id›"],
];
export const stableText = (t: string) => VOLATILE.reduce((out, [re, mask]) => out.replace(re, mask), t);

/** `el`'s and its ancestors' texts, closest first; `masked`: with run-dependent values replaced (see VOLATILE). */
const texts = (el: Element, masked = true) => {
  const out: string[] = [];
  for (let p: Element | undefined = el; p; p = p.parent) {
    let t = p.text.trim().replace(/\s+/g, " ");
    if (masked) t = stableText(t);
    if (t)
      out.push(
        t.length <= NEAR_MAX ? t : `${t.slice(0, 80)}… [${createHash("sha256").update(t).digest("hex").slice(0, 8)}]`,
      );
  }
  return out;
};

/** The closest own-or-ancestor node of `el` whose text holds `hint` (any case). */
const holder = (el: Element, hint: string) => {
  const h = hint.toLowerCase();
  let p: Element | undefined = el;
  while (p && !p.text.toLowerCase().includes(h)) p = p.parent;
  return p;
};
/**
 * `hint` tells `el` apart from its same-named `peers`: it is in `el`'s own part of the page (its row, its card) and in
 * no peer's own part. A hint in every row ("Draft"), or only in what they share (a list heading), tells nothing.
 */
const anchors = (el: Element, hint: string, peers: Element[]) => {
  const own = holder(el, hint);
  if (!own || peers.some((q) => within(q, own))) return false;
  return peers.every((q) => {
    const theirs = holder(q, hint);
    return !theirs || within(el, theirs);
  });
};

/** `hints`: values the Step quotes, preferred over any other text to tell `el` from same-named peers (an action's target). */
export function resolve(el: Element, among: Element[], hints: string[] = []): Resolution {
  const r = { role: el.role, name: el.name, container: containerOf(el) };
  const peers = among.filter((e) => e !== el && same(e, r));
  if (!peers.length) return r;
  const anchor = hints.find((h) => h.trim() && anchors(el, h, peers));
  if (anchor) return { ...r, anchor };
  const near = texts(el).find((t) => !peers.some((p) => texts(p).includes(t)));
  if (near) return { ...r, near };
  const all = among.filter((e) => same(e, r));
  return { ...r, nth: all.indexOf(el), of: all.length };
}

/** The element a Resolution names on this Observation, or why none does: exactly one must match all of it. */
export function find(r: Resolution, among: Element[]): Element | string {
  const named = among.filter((e) => same(e, r));
  const anchored = named.filter(
    (e) =>
      r.anchor === undefined ||
      anchors(
        e,
        r.anchor,
        named.filter((q) => q !== e),
      ),
  );
  const pick = (peers: Element[]) =>
    r.of !== undefined
      ? peers.length === r.of
        ? peers[r.nth!]
        : undefined
      : peers.length === 1
        ? peers[0]
        : undefined;
  const { near } = r;
  if (near === undefined) return pick(anchored) ?? fail(r, anchored.length);
  // A `near` recorded before masking existed holds the raw text. Match it as written first: it is the most specific
  // (rows that differ only by a time). Then masked, the way the page's texts are masked, so its date or time still
  // matches a day later. A new `near` is already masked, so the raw pass finds nothing and the masked one decides.
  const raw = anchored.filter((e) => texts(e, false).includes(near));
  const masked = anchored.filter((e) => texts(e).includes(stableText(near)));
  return pick(raw) ?? pick(masked) ?? fail(r, masked.length);
}

/** A long text is kept as its start and a hash; masking cannot repair a hash taken over a date or time. */
const HASHED = /… \[[0-9a-f]{8}\]$/;
const fail = (r: Resolution, found: number) =>
  `${describe(r)} matches ${found} elements now, needs ${r.of ?? "exactly 1"}` +
  (found === 0 && r.near !== undefined && HASHED.test(r.near)
    ? "; its near is a hashed long text, which changes with any date or time in it: re-record with --record new"
    : "");

export const describe = (t: Target) =>
  typeof t === "string"
    ? t
    : `${t.role}${t.name ? ` "${t.name}"` : ""}${t.container ? ` in ${t.container}` : ""}${t.anchor ? ` for "${t.anchor}"` : ""}${t.near ? ` near "${t.near}"` : ""}${t.of ? ` (#${t.nth! + 1} of ${t.of} identical)` : ""}`;

/** A live answer for the cassette: refs (looked up in `among`) become Resolutions. */
const store = (p: Pick, among: Element[] = [], minimum = 0, hints: string[] = []): Answer =>
  [
    ...new Set([
      ...plausible(p, Math.max(DEFAULTS.confidence.answer, confidence(p).answer)),
      ...Object.keys(p.probabilities)
        .sort((a, b) => p.probabilities[b] - p.probabilities[a])
        .slice(0, minimum),
    ]),
  ].map((k) => {
    const el = among.find((e) => e.ref === k);
    const target = el ? resolve(el, among, hints) : (goneResolution<Resolution>(k) ?? k);
    // A healed Step can mix replayed answers with live ones using different confidence.
    return p.recordedConfidence ? [target, p.probabilities[k], p.recordedConfidence] : [target, p.probabilities[k]];
  });
/** A Resolution that names no single element on this Observation: the only miss a later Observation can fix. */
class NotOnPage {
  why: string;
  constructor(why: string) {
    this.why = why;
  }
}

/**
 * A recorded answer on this Observation. `required` says which recorded elements must still name exactly one element,
 * else NotOnPage: `all` (a check's subject and area: every plausible reading is evaluated, so every one must exist),
 * `top` (a Turn's target: only the first is acted on; the rest matter through their probability alone) or `none` (the
 * Step is done: nothing is acted on). A candidate that is not required and not found stays in the answer as a gone
 * key, so the gates see the distribution as recorded: its mass still counts against the top's margin.
 */
const load = (a: Answer, among: Element[] = [], required: "all" | "top" | "none" = "all"): Pick => {
  const probabilities = Object.fromEntries(
    a.map(([t, v], i) => {
      if (typeof t === "string") return [t, v];
      const el = find(t, among);
      if (typeof el !== "string") return [el.ref, v];
      if (required === "all" || (required === "top" && i === 0)) throw new NotOnPage(el);
      return [goneKey(t), v];
    }),
  );
  return {
    choice: Object.keys(probabilities)[0],
    probabilities,
    ...(a[0]?.[2] ? { recordedConfidence: a[0][2] } : {}),
  };
};

/**
 * A Step's cassette key: scenario and label, plus which occurrence of that label it is in the scenario, so adding or
 * removing other Steps keeps every other key.
 */
export function stepKey(scenario: string, labels: string[], i: number): string {
  const n = labels.slice(0, i).filter((l) => l === labels[i]).length + 1;
  return `${scenario}: ${labels[i]}${n > 1 ? ` (#${n})` : ""}`;
}

/** Recorded resolutions per Step, in `<test>.cassette.json`. Steps are keyed by scenario, text and occurrence (stepKey). */
export class Cassette {
  #file: File;
  #dirty = false;
  replayed = 0;
  recorded = 0;
  healed = 0;
  path: string;
  model: string;
  mode: RecordMode;
  #run?: string;

  /**
   * `run`: id of this run. Parallel workers each open the feature's cassette; a file last saved by this run holds
   * another worker's scenarios, so it is not stale for `all`.
   */
  constructor(path: string, model: string, mode: RecordMode, run?: string) {
    this.path = path;
    this.model = model;
    this.mode = mode;
    this.#run = run;
    const { file: old, thisRun } = this.#read();
    this.#file = { model, run, entries: this.#keep(old, thisRun) ?? {} };
    if (old && !this.#keep(old, thisRun) && mode !== "none") this.#dirty = true; // replay-only never rewrites
  }

  #read(): { file?: File; thisRun: boolean } {
    try {
      if (!existsSync(this.path)) return { thisRun: false };
      const file: File = JSON.parse(readFileSync(this.path, "utf8"));
      return { file, thisRun: this.#run !== undefined && file.run === this.#run };
    } catch (err) {
      throw new Error(`Cannot read cassette ${this.path}: ${(err as Error).message}. Delete it to record again.`);
    }
  }

  /** Entries of a file on disk worth keeping: in `all` mode only those recorded in this run. */
  #keep(file: File | undefined, thisRun: boolean): Record<string, Entry> | undefined {
    return file && (this.mode !== "all" || thisRun) ? file.entries : undefined;
  }

  /**
   * The Decider for one Step: replays its recorded resolutions while each still matches exactly one element, else
   * (from the first that does not) asks `live`. Call `done` when the Step ends.
   */
  step(
    key: string,
    live: Decider,
    log: (line: string) => void = () => {},
    generated: Record<string, string> = {},
  ): Decider & { done(keep: boolean): "replayed" | "recorded" | "healed" | undefined; positional(): string[] } {
    const saved = this.mode === "all" ? undefined : this.#file.entries[key];
    const old = saved && mapEntry(saved, (value) => fill(value, generated));
    const now: Entry = { confidence: settings().confidence };
    const recorded = (pick: Pick): Pick => ({
      ...pick,
      recordedConfidence: pick.recordedConfidence ?? old?.confidence ?? DEFAULTS.confidence,
    });
    const loadRecorded = (a: Answer, among: Element[] = [], required?: Parameters<typeof load>[2]) =>
      recorded(load(a, among, required));
    let broken: string | undefined; // why replay stopped
    const positional = new Set<string>(); // acted-on targets only a position tells apart from their twins
    let offered: { elements: Element[]; hints: string[] } | undefined; // the latest Turn's page, for acted()
    let turn = 0;
    const replayOnly = this.mode === "none";
    /** `wait`: replay-only waits for a loading page to show the element (NotYet); live mode just asks Jev, who can answer "wait". */
    const fail = (why: string, wait = false) => {
      if (replayOnly && old && wait) throw new NotYet(new UiChanged(`the recorded resolution no longer holds: ${why}`));
      if (replayOnly)
        throw new UiChanged(
          old
            ? `the recorded resolution no longer holds: ${why}`
            : "this step has no recorded resolution: it is new or was reworded after the cassette was recorded, and replay-only mode does not call Jev",
        );
      if (old && !broken) log(`  (cassette: healing, ${why})`);
      broken ??= why;
    };
    /**
     * Replay is the live question without Jev: a recorded answer is used only while the question would offer it now
     * (`get` throws why not). Only an element not on the page yet is waited for; any other miss is final.
     */
    const replay = <T>(get: (e: Entry) => T): T | undefined => {
      if (broken || !old) {
        if (!broken) fail("missing");
        return undefined;
      }
      try {
        return get(old);
      } catch (why) {
        if (why instanceof NotOnPage) fail(why.why, true);
        else if (typeof why === "string") fail(why);
        else throw why;
        return undefined;
      }
    };

    /** Actions the answer's top target can do now (none known: undefined); the runner reads only these. */
    const can = (a: TurnAnswer, obs: Observation, keys: string[]) => {
      const top = a.target.choice === PAGE ? PAGE : obs.elements.find((e) => e.ref === a.target.choice);
      return top ? capabilities(top, obs, keys) : undefined;
    };

    return {
      turn: async (step, obs, recent, attempt, keys) => {
        const i = turn; // advanced only once answered: a NotYet retries the same recorded turn
        const r = replay((e) => {
          const t = e.turns?.[i];
          if (!t) throw `recorded ${e.turns?.length ?? 0} turns, this is turn ${i + 1}`;
          if ("dialog" in t) throw `turn ${i + 1} answered a browser dialog when recorded`;
          const gone = t.target.find(([k]) => typeof k === "string" && k !== "none" && k !== PAGE);
          if (gone) throw `recorded answer "${gone[0]}" is not offered now`;
          const a: TurnAnswer = {
            done: t.done,
            target: {
              ...loadRecorded(t.target, obs.elements, t.done >= DONE_THRESHOLD ? "none" : "top"),
              ...(e.pinned?.some((p) => p.turn === i + 1) ? { confirmed: true } : {}),
            },
            action: t.action && loadRecorded(t.action),
          };
          // The recorded action must still be one the recorded target can do (a key the Step names, Enter in a focused field).
          const ok = can(a, obs, keys ?? []);
          if (ok && a.action && !Object.keys(a.action.probabilities).some((k) => ok.includes(k)))
            throw `recorded action "${a.action.choice}" is not offered now`;
          return a;
        });
        turn = i + 1;
        const a = r ?? (await live.turn(step, obs, recent, attempt, keys));
        // Store the action restricted to what the target can do: Jev's top action may be one it cannot (task 0067).
        const ok = can(a, obs, keys ?? []);
        const action =
          a.action && ok
            ? {
                ...a.action,
                probabilities: Object.fromEntries(
                  Object.entries(a.action.probabilities).filter(([k]) => ok.includes(k)),
                ),
              }
            : a.action;
        const hints = readStep({ text: step, kind: "action" }).quoted;
        offered = { elements: obs.elements, hints };
        (now.turns ??= [])[i] = {
          done: a.done,
          target: store(
            a.target,
            obs.elements,
            gate(a.target, confidence(a.target).target, GATE_TARGET_MARGIN) ? 0 : 3,
            hints,
          ),
          action: action && store(action),
        };
        return a;
      },
      value: async (step, obs, el, candidates) => {
        const i = turn - 1;
        const r = replay((e) => {
          const t = e.turns?.[i];
          const v = t && "value" in t ? t.value : undefined;
          const gone = v?.find(([k]) => k !== "none" && !candidates.includes(k as string));
          if (!v) throw "no recorded value";
          if (gone) throw `recorded value "${gone[0]}" is not offered now`;
          return loadRecorded(v);
        });
        const a = r ?? (await live.value(step, obs, el, candidates));
        (now.turns![i] as { value?: Answer }).value = store(a);
        return a;
      },
      drop: async (step, obs, source) => {
        const i = turn - 1;
        const among = [...new Set([...obs.readable, ...obs.areas])];
        const r = replay((e) => {
          const t = e.turns?.[i];
          const d = t && "drop" in t ? t.drop : undefined;
          if (!d) throw "no recorded drop target";
          return loadRecorded(d, among, "top");
        });
        const a = r ?? (await live.drop(step, obs, source));
        (now.turns![i] as { drop?: Answer }).drop = store(a, among, 0, readStep({ text: step, kind: "action" }).quoted);
        return a;
      },
      dialog: async (step, obs, answers) => {
        const i = turn;
        const r = replay((e) => {
          const t = e.turns?.[i];
          if (!t || !("dialog" in t)) throw `turn ${i + 1} did not answer a browser dialog when recorded`;
          const gone = t.dialog.find(([k]) => !answers.includes(k as string));
          if (gone) throw `recorded dialog answer "${gone[0]}" is not offered now`;
          return loadRecorded(t.dialog);
        });
        turn = i + 1;
        const a = r ?? (await live.dialog(step, obs, answers));
        (now.turns ??= [])[i] = { dialog: store(a) };
        return a;
      },
      assess: async (step, obs, judged) => {
        // A judged check is Jev's verdict, and verdicts are never stored.
        if (judged) {
          broken ??= "judged";
          return live.assess(step, obs, judged);
        }
        const r = replay((e): Assessment => {
          if (!e.check) throw "no recorded check";
          if (!e.check.negated) throw "the check was recorded before negation was its own answer (issue #81)";
          return {
            kind: recorded(e.check.kind),
            negated: recorded(e.check.negated),
            state: recorded(e.check.state),
            subject: loadRecorded(e.check.subject, obs.readable),
            area: loadRecorded(e.check.area, obs.areas),
          };
        });
        const a = r ?? (await live.assess(step, obs, judged));
        now.check = {
          kind: a.kind,
          negated: a.negated,
          state: a.state,
          subject: store(a.subject, obs.readable),
          area: store(a.area, obs.areas),
        };
        return a;
      },
      intent: async (step, check) => {
        // Replayed as recorded; an entry from before intents existed was recorded with the rules alone, so it replays
        // that way without breaking the Step.
        if (old && !broken && this.mode !== "all") return (now.intent = old.intent ?? {});
        if (replayOnly) return (now.intent = {}); // the Step's first question will report the missing resolution
        return (now.intent = (await live.intent?.(step, check)) ?? {});
      },
      recall: async (step, earlier) => {
        const r = replay((e) => {
          if (!e.recall) throw "no recorded recall";
          const gone = e.recall.find(([k]) => k !== "none" && !((k as string) in earlier));
          if (gone) throw `recorded earlier value "${gone[0]}" is not in this scenario now`;
          return loadRecorded(e.recall);
        });
        const a = r ?? (await live.recall(step, earlier));
        now.recall = store(a);
        return a;
      },
      acted: (ref: string) => {
        const el = offered?.elements.find((e) => e.ref === ref);
        const r = el && resolve(el, offered!.elements, offered!.hints);
        if (r?.of !== undefined) positional.add(describe(r));
      },
      /** Elements this Step acted on that only their position among identical twins identifies. */
      positional: () => [...positional],
      /** `keep`: the Step reached an outcome from its answers (not an error), so they are written back. */
      done: (keep: boolean) => {
        if (!broken && old) {
          this.replayed++;
          return "replayed";
        }
        if (!keep || broken === "judged" || replayOnly) return; // replayOnly: a Step that asked Jev nothing ("I press Escape")
        this.#file.entries[key] = mapEntry(now, (value) => templateValue(value, generated));
        this.#dirty = true;
        if (old) {
          this.healed++;
          log(`  (cassette: healed, written back)`);
          return "healed";
        }
        this.recorded++;
        return "recorded";
      },
    };
  }

  resolutions(key: string, step: ParsedStep): string[] {
    if (!singleAction(step)) return [];
    return candidates(this.#file.entries[key]).map(([r, p], i) => `${i + 1}. ${describe(r)} (${Math.round(p * 100)}%)`);
  }

  save() {
    if (!this.#dirty) return;
    const { file, thisRun } = this.#read(); // another worker may have saved scenarios of this feature since
    this.#file.entries = { ...this.#keep(file, thisRun), ...this.#file.entries };
    writeFileSync(this.path + ".tmp", formatFile(this.#file));
    renameSync(this.path + ".tmp", this.path); // atomic: a crash mid-save never leaves half a cassette
  }
}
