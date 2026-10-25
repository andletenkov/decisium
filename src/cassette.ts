import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { capabilities, NotYet, PAGE, plausible, type Assessment, type Decider, type Pick, type TurnAnswer } from "./decision.ts";
import type { Element, Observation } from "./observation.ts";

/** none: replay only, a missing or broken resolution fails. new: replay, resolve missing/broken Steps live. all: always live. */
export type RecordMode = "none" | "new" | "all";
export const RECORD_MODES: RecordMode[] = ["none", "new", "all"];

/**
 * What a Step resolved to (ADR 0002, reopened by task 0032): the element by role, name, its nearest named container,
 * and, when it has same-named peers there, `near`: the text of its closest own-or-ancestor node that no peer shares
 * (the product card "Backpack $29.99 Add to cart"). Only twins no text tells apart fall back to a position (`nth` of
 * `of`): a reorder of them is invisible, but so is any difference between them.
 */
export interface Resolution { role: string; name: string; container: string; near?: string; nth?: number; of?: number }
type Target = Resolution | string; // a string: a non-element answer (scroll, wait, enter, none, page, missing)
/**
 * A Jev answer with element refs as Resolutions, only its plausible part (most likely first, until together 0.8):
 * the part the confidence gates and runner.ts read, so replay reaches the same outcome, a failing one included.
 */
type Answer = [Target, number][];
type Turn = { done: number; target: Answer; action?: Answer; value?: Answer; drop?: Answer } | { dialog: Answer }; // dialog: a Turn answering a browser dialog
interface Check { kind: Pick; state: Pick; subject: Answer; area: Answer }
interface Entry { turns?: Turn[]; check?: Check; recall?: Answer }
interface File { model: string; run?: string; entries: Record<string, Entry> } // run: id of the run that last saved it

/** Replay-only mode and a Step whose recorded resolution is missing or no longer holds. */
export class UiChanged extends Error {
  reason: string; // for people
  constructor(reason: string) { super(`UI_CHANGED: ${reason}`); this.reason = reason; }
}

/** Nearest ancestor with a name, e.g. `list "Issues"`; "" at the top. */
const containerOf = (el: Element) => {
  for (let p = el.parent; p; p = p.parent) if (p.name) return `${p.role} "${p.name}"`;
  return "";
};
const same = (el: Element, r: Omit<Resolution, "nth" | "of">) => el.role === r.role && el.name === r.name && containerOf(el) === r.container;

const NEAR_MAX = 200; // a longer text is kept as its start and a hash, so the cassette stays readable
/** `el`'s and its ancestors' texts, closest first. */
const texts = (el: Element) => {
  const out: string[] = [];
  for (let p: Element | undefined = el; p; p = p.parent) {
    const t = p.text.trim().replace(/\s+/g, " ");
    if (t) out.push(t.length <= NEAR_MAX ? t : `${t.slice(0, 80)}… [${createHash("sha256").update(t).digest("hex").slice(0, 8)}]`);
  }
  return out;
};

export function resolve(el: Element, among: Element[]): Resolution {
  const r = { role: el.role, name: el.name, container: containerOf(el) };
  const peers = among.filter(e => e !== el && same(e, r));
  if (!peers.length) return r;
  const near = texts(el).find(t => !peers.some(p => texts(p).includes(t)));
  if (near) return { ...r, near };
  const all = among.filter(e => same(e, r));
  return { ...r, nth: all.indexOf(el), of: all.length };
}

/** The element a Resolution names on this Observation, or why none does: exactly one must match all of it. */
export function find(r: Resolution, among: Element[]): Element | string {
  const peers = among.filter(e => same(e, r) && (r.near === undefined || texts(e).includes(r.near)));
  if (r.of !== undefined && peers.length === r.of) return peers[r.nth!];
  if (r.of === undefined && peers.length === 1) return peers[0];
  return `${describe(r)} matches ${peers.length} elements now, needs ${r.of ?? "exactly 1"}`;
}

export const describe = (t: Target) => typeof t === "string" ? t
  : `${t.role}${t.name ? ` "${t.name}"` : ""}${t.container ? ` in ${t.container}` : ""}${t.near ? ` near "${t.near}"` : ""}${t.of ? ` (#${t.nth! + 1} of ${t.of} identical)` : ""}`;

/** A live answer for the cassette: refs (looked up in `among`) become Resolutions. */
const store = (p: Pick, among: Element[] = []): Answer => plausible(p).map(k => {
  const el = among.find(e => e.ref === k);
  return [el ? resolve(el, among) : k, p.probabilities[k]];
});
/** A Resolution that names no single element on this Observation: the only miss a later Observation can fix. */
class NotOnPage { why: string; constructor(why: string) { this.why = why; } }

/** A recorded answer on this Observation; throws NotOnPage when a Resolution no longer names exactly one element. */
const load = (a: Answer, among: Element[] = []): Pick => {
  const probabilities = Object.fromEntries(a.map(([t, v]) => {
    if (typeof t === "string") return [t, v];
    const el = find(t, among);
    if (typeof el === "string") throw new NotOnPage(el);
    return [el.ref, v];
  }));
  return { choice: Object.keys(probabilities)[0], probabilities };
};

/**
 * A Step's cassette key: scenario and label, plus which occurrence of that label it is in the scenario, so adding or
 * removing other Steps keeps every other key.
 */
export function stepKey(scenario: string, labels: string[], i: number): string {
  const n = labels.slice(0, i).filter(l => l === labels[i]).length + 1;
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

  /** Entries of a file on disk worth keeping: same model, and in `all` mode only those recorded in this run. */
  #keep(file: File | undefined, thisRun: boolean): Record<string, Entry> | undefined {
    return file && file.model === this.model && (this.mode !== "all" || thisRun) ? file.entries : undefined;
  }

  /**
   * The Decider for one Step: replays its recorded resolutions while each still matches exactly one element, else
   * (from the first that does not) asks `live`. Call `done` when the Step ends.
   */
  step(key: string, live: Decider, log: (line: string) => void = () => {}): Decider & { done(keep: boolean): "replayed" | "recorded" | "healed" | undefined } {
    const old = this.mode === "all" ? undefined : this.#file.entries[key];
    const now: Entry = {};
    let broken: string | undefined; // why replay stopped
    let turn = 0;
    const replayOnly = this.mode === "none";
    /** `wait`: replay-only waits for a loading page to show the element (NotYet); live mode just asks Jev, who can answer "wait". */
    const fail = (why: string, wait = false) => {
      if (replayOnly && old && wait) throw new NotYet(new UiChanged(`the recorded resolution no longer holds: ${why}`));
      if (replayOnly) throw new UiChanged(old ? `the recorded resolution no longer holds: ${why}` : "this step has no recorded resolution: it is new or was reworded after the cassette was recorded, and replay-only mode does not call Jev");
      if (old && !broken) log(`  (cassette: healing, ${why})`);
      broken ??= why;
    };
    /**
     * Replay is the live question without Jev: a recorded answer is used only while the question would offer it now
     * (`get` throws why not). Only an element not on the page yet is waited for; any other miss is final.
     */
    const replay = <T>(get: (e: Entry) => T): T | undefined => {
      if (broken || !old) { if (!broken) fail("missing"); return undefined; }
      try { return get(old); } catch (why) {
        if (why instanceof NotOnPage) fail(why.why, true);
        else if (typeof why === "string") fail(why);
        else throw why;
        return undefined;
      }
    };

    /** Actions the answer's top target can do now (none known: undefined); the runner reads only these. */
    const can = (a: TurnAnswer, obs: Observation, keys: string[]) => {
      const top = a.target.choice === PAGE ? PAGE : obs.elements.find(e => e.ref === a.target.choice);
      return top ? capabilities(top, obs, keys) : undefined;
    };

    return {
      turn: async (step, obs, recent, attempt, keys) => {
        const i = turn; // advanced only once answered: a NotYet retries the same recorded turn
        const r = replay(e => {
          const t = e.turns?.[i];
          if (!t) throw `recorded ${e.turns?.length ?? 0} turns, this is turn ${i + 1}`;
          if ("dialog" in t) throw `turn ${i + 1} answered a browser dialog when recorded`;
          const gone = t.target.find(([k]) => typeof k === "string" && k !== "none" && k !== PAGE);
          if (gone) throw `recorded answer "${gone[0]}" is not offered now`;
          const a: TurnAnswer = { done: t.done, target: load(t.target, obs.elements), action: t.action && load(t.action) };
          // The recorded action must still be one the recorded target can do (a key the Step names, Enter in a focused field).
          const ok = can(a, obs, keys ?? []);
          if (ok && a.action && !Object.keys(a.action.probabilities).some(k => ok.includes(k))) throw `recorded action "${a.action.choice}" is not offered now`;
          return a;
        });
        turn = i + 1;
        const a = r ?? await live.turn(step, obs, recent, attempt, keys);
        // Store the action restricted to what the target can do: Jev's top action may be one it cannot (task 0067).
        const ok = can(a, obs, keys ?? []);
        const action = a.action && ok ? { ...a.action, probabilities: Object.fromEntries(Object.entries(a.action.probabilities).filter(([k]) => ok.includes(k))) } : a.action;
        (now.turns ??= [])[i] = { done: a.done, target: store(a.target, obs.elements), action: action && store(action) };
        return a;
      },
      value: async (step, obs, el, candidates) => {
        const i = turn - 1;
        const r = replay(e => {
          const t = e.turns?.[i];
          const v = t && "value" in t ? t.value : undefined;
          const gone = v?.find(([k]) => k !== "none" && !candidates.includes(k as string));
          if (!v) throw "no recorded value";
          if (gone) throw `recorded value "${gone[0]}" is not offered now`;
          return load(v);
        });
        const a = r ?? await live.value(step, obs, el, candidates);
        (now.turns![i] as { value?: Answer }).value = store(a);
        return a;
      },
      drop: async (step, obs, source) => {
        const i = turn - 1;
        const among = [...new Set([...obs.readable, ...obs.areas])];
        const r = replay(e => {
          const t = e.turns?.[i];
          const d = t && "drop" in t ? t.drop : undefined;
          if (!d) throw "no recorded drop target";
          return load(d, among);
        });
        const a = r ?? await live.drop(step, obs, source);
        (now.turns![i] as { drop?: Answer }).drop = store(a, among);
        return a;
      },
      dialog: async (step, obs, answers) => {
        const i = turn;
        const r = replay(e => {
          const t = e.turns?.[i];
          if (!t || !("dialog" in t)) throw `turn ${i + 1} did not answer a browser dialog when recorded`;
          const gone = t.dialog.find(([k]) => !answers.includes(k as string));
          if (gone) throw `recorded dialog answer "${gone[0]}" is not offered now`;
          return load(t.dialog);
        });
        turn = i + 1;
        const a = r ?? await live.dialog(step, obs, answers);
        (now.turns ??= [])[i] = { dialog: store(a) };
        return a;
      },
      assess: async (step, obs, judged) => {
        // A judged check is Jev's verdict, and verdicts are never stored.
        if (judged) { broken ??= "judged"; return live.assess(step, obs, judged); }
        const r = replay((e): Assessment => {
          if (!e.check) throw "no recorded check";
          return { kind: e.check.kind, state: e.check.state, subject: load(e.check.subject, obs.readable), area: load(e.check.area, obs.areas) };
        });
        const a = r ?? await live.assess(step, obs, judged);
        now.check = { kind: a.kind, state: a.state, subject: store(a.subject, obs.readable), area: store(a.area, obs.areas) };
        return a;
      },
      recall: async (step, earlier) => {
        const r = replay(e => {
          if (!e.recall) throw "no recorded recall";
          const gone = e.recall.find(([k]) => k !== "none" && !(k as string in earlier));
          if (gone) throw `recorded earlier value "${gone[0]}" is not in this scenario now`;
          return load(e.recall);
        });
        const a = r ?? await live.recall(step, earlier);
        now.recall = store(a);
        return a;
      },
      /** `keep`: the Step reached an outcome from its answers (not an error), so they are written back. */
      done: (keep: boolean) => {
        if (!broken && old) { this.replayed++; return "replayed"; }
        if (!keep || broken === "judged" || replayOnly) return; // replayOnly: a Step that asked Jev nothing ("I press Escape")
        this.#file.entries[key] = now;
        this.#dirty = true;
        if (old) { this.healed++; log(`  (cassette: healed, written back)`); return "healed"; }
        this.recorded++;
        return "recorded";
      },
    };
  }

  save() {
    if (!this.#dirty) return;
    const { file, thisRun } = this.#read(); // another worker may have saved scenarios of this feature since
    this.#file.entries = { ...this.#keep(file, thisRun), ...this.#file.entries };
    writeFileSync(this.path + ".tmp", JSON.stringify(this.#file, null, 2) + "\n");
    renameSync(this.path + ".tmp", this.path); // atomic: a crash mid-save never leaves half a cassette
  }
}
