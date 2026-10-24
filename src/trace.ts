import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Action, Browser } from "./browser.ts";
import { traced, type Decider } from "./decision.ts";
import type { Runtime } from "./runner.ts";

/** File in the run directory marking an infrastructure error (exit 2), written by any worker, read by the CLI. */
export const INFRA_MARKER = "infrastructure-error";

/** runs/<timestamp>/: trace.jsonl for the whole run, one folder per scenario with a screenshot per Turn. */
export class RunDir {
  readonly path: string;
  #scenario = "";
  #dir = "";
  #shot = 0;
  #ui = ""; // the scenario's last Observation, written next to the screenshots on failure
  /** `existing`: a run directory the CLI created, shared by parallel workers. */
  constructor(root = "runs", existing?: string) {
    if (existing) { mkdirSync(existing, { recursive: true }); this.path = existing; return; }
    mkdirSync(root, { recursive: true });
    const base = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
    // Parallel runs can start in the same millisecond: mkdir without `recursive` fails if the directory exists.
    for (let i = 1; ; i++) {
      const path = i === 1 ? base : `${base}-${i}`;
      try { mkdirSync(path); this.path = path; return; } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    }
  }

  #lines: string[] = [];

  /** Full verbose log of the run (what -v prints). Buffered per scenario so parallel workers do not interleave lines. */
  log(line: string) {
    this.#lines.push(line);
  }

  /** Appends the buffered scenario log to log.txt in one write. Call at the end of every scenario. */
  flush() {
    if (this.#lines.length) appendFileSync(join(this.path, "log.txt"), this.#lines.join("\n") + "\n");
    this.#lines = [];
  }

  /** End of the run: drop the folder-number claims. */
  done() {
    rmSync(join(this.path, ".claimed"), { recursive: true, force: true });
  }

  /** Last screenshot of the current scenario, for failure reports. */
  get lastScreenshot(): string | undefined {
    return this.#shot ? join(this.#dir, `${String(this.#shot).padStart(3, "0")}.png`) : undefined;
  }

  event(type: string, data: Record<string, unknown> = {}) {
    appendFileSync(join(this.path, "trace.jsonl"), JSON.stringify({ t: new Date().toISOString(), scenario: this.#scenario, type, ...data }) + "\n");
  }

  scenario(name: string): string {
    this.#scenario = name;
    this.#shot = 0;
    this.#ui = "";
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    // Numbered in start order across parallel workers: claim a number with an exclusive mkdir, then name the folder.
    mkdirSync(join(this.path, ".claimed"), { recursive: true });
    let i = 1;
    for (; ; i++) {
      try { mkdirSync(join(this.path, ".claimed", String(i))); break; } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    }
    this.#dir = join(this.path, `${String(i).padStart(2, "0")}-${slug}`);
    mkdirSync(this.#dir, { recursive: true });
    this.event("scenario");
    return this.#dir;
  }

  /** Every Observation is a Turn: screenshot it and log the Observation text. */
  runtime(b: Browser): Runtime {
    const rt: Runtime = {
      observe: async () => {
        const obs = await b.observe();
        const screenshot = `${String(++this.#shot).padStart(3, "0")}.png`;
        await b.screenshot(join(this.#dir, screenshot));
        this.event("observe", { screenshot, ui: obs.text });
        this.#ui = obs.text;
        return obs;
      },
      execute: async (a: Action) => {
        this.event("execute", { ...a, value: a.value === undefined ? undefined : "(see log; may be secret)" });
        await b.execute(a);
      },
      waitForChange: (since, ms) => b.waitForChange(since, ms),
      stale: () => b.stale(),
      actionStep: (run, log) => b.actionStep(run, log, rt.execute),
    };
    return rt;
  }

  /** Jev's answers with their probabilities, one event per question. Values chosen for secret fields are masked. */
  decider(d: Decider): Decider {
    return traced(d, (type, data) => this.event(type, data));
  }

  /** On failure: console errors and the last page text next to the screenshots (the Playwright trace is saved by Browser.close). */
  failure(errors: string[]) {
    writeFileSync(join(this.#dir, "console-errors.txt"), errors.length ? errors.join("\n") + "\n" : "(none)\n");
    if (this.#ui) writeFileSync(join(this.#dir, "ui.txt"), this.#ui + "\n");
  }
}
