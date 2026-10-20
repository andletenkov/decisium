import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** once: record if no cassette yet, else replay only. none: replay only. new: replay, record misses. all: always live. */
export type RecordMode = "once" | "none" | "new" | "all";
export const RECORD_MODES: RecordMode[] = ["once", "none", "new", "all"];

interface Entry { request: unknown; response: unknown }
interface File { model: string; entries: Record<string, Entry> }

/** No recorded answer for this exact request in replay-only mode: the UI (or the Step) differs from the recording. */
export class UiChanged extends Error {
  diff: string;
  constructor(diff: string) { super(`UI_CHANGED: no recorded Jev answer for this Observation\n${diff}`); this.diff = diff; }
}

/** Recorded Jev request/response pairs, keyed by SHA-256 of the full request (ADR 0002). */
export class Cassette {
  #file: File;
  #replayOnly: boolean;
  #live: boolean;
  #dirty = false;
  hits = 0;
  recorded = 0;
  #drift: boolean;

  path: string;
  model: string;

  constructor(path: string, model: string, mode: RecordMode) {
    this.path = path;
    this.model = model;
    const old: File | undefined = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
    const keep = old && old.model === model && mode !== "all"; // other model version: discard whole cassette
    this.#file = { model, entries: keep ? old.entries : {} };
    if (old && !keep) this.#dirty = true;
    this.#replayOnly = mode === "none" || (mode === "once" && !!old);
    this.#live = mode === "all";
    this.#drift = mode === "new" && !!old;
  }

  async call<T>(request: unknown, live: () => Promise<T>): Promise<T> {
    const key = createHash("sha256").update(JSON.stringify({ model: this.model, request })).digest("hex");
    const hit = this.#file.entries[key];
    if (hit && !this.#live) { this.hits++; return hit.response as T; }
    if (this.#replayOnly) throw new UiChanged(this.#diff(request));
    this.recorded++;
    if (this.#drift) console.log(`  (cassette miss: live Jev call recorded, drift from ${this.path})`);
    const response = await live();
    this.#file.entries[key] = { request, response };
    this.#dirty = true;
    return response;
  }

  save() {
    if (this.#dirty) writeFileSync(this.path, JSON.stringify(this.#file, null, 2) + "\n");
  }

  /** Observation difference against the closest recorded request for the same Step. */
  #diff(request: unknown): string {
    const ui = (r: unknown) => String((r as { state?: { ui?: string } }).state?.ui ?? "");
    const step = (r: unknown) => JSON.stringify({ ...(r as { state?: object }).state, ui: undefined, actions_taken_for_step: undefined });
    const lines = (s: string) => new Set(s.split("\n"));
    const now = lines(ui(request));
    let best: { removed: string[]; added: string[] } | undefined;
    for (const e of Object.values(this.#file.entries)) {
      if (step(e.request) !== step(request)) continue;
      const was = lines(ui(e.request));
      const removed = [...was].filter(l => !now.has(l)), added = [...now].filter(l => !was.has(l));
      if (!best || removed.length + added.length < best.removed.length + best.added.length) best = { removed, added };
    }
    if (!best) return "  no recording for this Step";
    if (!best.removed.length && !best.added.length) return "  Observation unchanged; the questions or recent actions differ";
    return [...best.removed.map(l => `  - ${l}`), ...best.added.map(l => `  + ${l}`)].join("\n");
  }
}
