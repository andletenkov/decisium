import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Action, Browser } from "./browser.ts";
import type { Decider } from "./jev.ts";
import type { Observation } from "./observation.ts";
import type { Runtime } from "./runner.ts";

/** runs/<timestamp>/: trace.jsonl for the whole run, one folder per scenario with a screenshot per Turn. */
export class RunDir {
  readonly path: string;
  #scenario = "";
  #dir = "";
  #shot = 0;

  constructor(root = "runs") {
    this.path = join(root, new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(this.path, { recursive: true });
  }

  event(type: string, data: Record<string, unknown> = {}) {
    appendFileSync(join(this.path, "trace.jsonl"), JSON.stringify({ t: new Date().toISOString(), scenario: this.#scenario, type, ...data }) + "\n");
  }

  scenario(index: number, name: string): string {
    this.#scenario = name;
    this.#shot = 0;
    this.#dir = join(this.path, `${String(index + 1).padStart(2, "0")}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}`);
    mkdirSync(this.#dir, { recursive: true });
    this.event("scenario");
    return this.#dir;
  }

  /** Every Observation is a Turn: screenshot it and log the Observation text. */
  runtime(b: Browser): Runtime {
    return {
      observe: async () => {
        const obs = await b.observe();
        const screenshot = `${String(++this.#shot).padStart(3, "0")}.png`;
        await b.screenshot(join(this.#dir, screenshot));
        this.event("observe", { screenshot, ui: obs.text });
        return obs;
      },
      execute: async (a: Action) => {
        this.event("execute", { ...a, value: a.value === undefined ? undefined : "(see log; may be secret)" });
        await b.execute(a);
      },
      waitForChange: (since, ms) => b.waitForChange(since, ms),
    };
  }

  /** Jev's answers with their probabilities. Values chosen for secret fields are masked. */
  decider(d: Decider): Decider {
    return {
      turn: async (step, obs: Observation, recent, attempt) => { const a = await d.turn(step, obs, recent, attempt); this.event("turn", { step, answer: a }); return a; },
      value: async (step, obs, el, candidates) => {
        const a = await d.value(step, obs, el, candidates);
        this.event("value", { step, element: el.line, answer: el.secret ? "(secret)" : a });
        return a;
      },
      assess: async (step, obs, judged) => { const a = await d.assess(step, obs, judged); this.event("assess", { step, answer: a }); return a; },
      recall: async (step, earlier) => { const a = await d.recall(step, earlier); this.event("recall", { step, answer: a }); return a; },
    };
  }

  /** On failure: console errors next to the screenshots (the Playwright trace is saved by Browser.close). */
  failure(errors: string[]) {
    writeFileSync(join(this.#dir, "console-errors.txt"), errors.length ? errors.join("\n") + "\n" : "(none)\n");
  }
}
