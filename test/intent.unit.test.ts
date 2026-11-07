import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Cassette } from "../src/cassette.ts";
import type { Decider } from "../src/decision.ts";

const path = () => `${mkdtempSync(`${tmpdir()}/intent-`)}/t.cassette.json`;
const live = (calls: { n: number }) =>
  ({
    intent: async () => {
      calls.n++;
      return { attempt: true };
    },
  }) as unknown as Decider;

test("cassette: an intent is recorded once and replayed with no Jev call (issue #31)", async () => {
  const p = path(),
    calls = { n: 0 };
  const rec = new Cassette(p, "m", "new");
  const d = rec.step("S: I submit the empty form", live(calls));
  assert.deepEqual(await d.intent!("I submit the empty form", false), { attempt: true });
  d.done(true);
  rec.save();
  const play = new Cassette(p, "m", "none").step("S: I submit the empty form", live(calls));
  assert.deepEqual(await play.intent!("I submit the empty form", false), { attempt: true });
  assert.equal(calls.n, 1);
});

test("cassette: an entry recorded before intents replays with the wording rules alone", async () => {
  const p = path(),
    calls = { n: 0 };
  writeFileSync(p, JSON.stringify({ model: "m", entries: { "S: I go back": { turns: [] } } }));
  for (const mode of ["none", "new"] as const) {
    const d = new Cassette(p, "m", mode).step("S: I go back", live(calls));
    assert.deepEqual(await d.intent!("I go back", false), {});
  }
  assert.equal(calls.n, 0);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).entries["S: I go back"].intent, undefined);
});

test("runner: an Action step that changed the page stops before a field it gives nothing to type (issue #31)", async () => {
  const { parseSnapshot } = await import("../src/observation.ts");
  const { runStep } = await import("../src/runner.ts");
  const cart = parseSnapshot(`- button "Checkout" [ref=e1]`);
  const form = parseSnapshot(`- textbox "First Name" [ref=e2]\n- button "Continue" [ref=e3]`);
  const sure = (choice: string) => ({ choice, probabilities: { [choice]: 0.95, other: 0.05 } });
  const run = async (done: number) => {
    let obs = cart;
    const d = {
      turn: async (_s: string, o: typeof cart) => ({ done: o === cart ? 0 : done, target: sure(o.elements[0].ref) }),
    } as unknown as Decider;
    const rt = {
      actionStep: (f: () => Promise<unknown>) => f(),
      observe: async () => obs,
      execute: async () => {
        obs = form;
      },
      waitForChange: async () => false,
    };
    return (await runStep("ich zur Kasse gehe", rt as any, d, () => {})).outcome;
  };
  assert.equal(await run(0.77), "DONE");
  assert.equal(await run(0.3), "AMBIGUOUS"); // Jev thinks there is more to do: still asks for a value
});

test("runner: an Action step that moved to a new page stops there instead of doing the next Step's task", async () => {
  const { parseSnapshot, withPage } = await import("../src/observation.ts");
  const { runStep } = await import("../src/runner.ts");
  // SauceDemo "I continue": Continue opened the overview, done 0.78, and the Step went on to click Finish.
  const form = withPage(parseSnapshot(`- button "Continue" [ref=e1]`), "https://x.dev/step-one", "Shop");
  const overview = withPage(parseSnapshot(`- button "Finish" [ref=e2]`), "https://x.dev/step-two", "Shop");
  const samePage = withPage(parseSnapshot(`- button "Finish" [ref=e2]`), "https://x.dev/step-one", "Shop");
  const complete = withPage(parseSnapshot(`- button "Back Home" [ref=e3]`), "https://x.dev/complete", "Shop");
  const sure = (choice: string) => ({ choice, probabilities: { [choice]: 0.95, other: 0.05 } });
  const run = async (after: typeof form, done: number) => {
    let obs = form;
    const clicked: string[] = [];
    const d = {
      turn: async (_s: string, o: typeof form) => ({
        done: o === form ? 0 : o === complete ? 0.9 : done,
        target: sure(o.elements[0].ref),
      }),
    } as unknown as Decider;
    const rt = {
      actionStep: (f: () => Promise<unknown>) => f(),
      observe: async () => obs,
      execute: async (a: { ref?: string }) => {
        clicked.push(a.ref!);
        obs = obs === form ? after : complete;
      },
      waitForChange: async () => false,
    };
    const { outcome } = await runStep("I continue", rt as any, d, () => {});
    return `${outcome} ${clicked.join(",")}`;
  };
  assert.equal(await run(overview, 0.78), "DONE e1");
  assert.equal(await run(overview, 0.3), "DONE e1,e2"); // Jev says the task is not done yet: it goes on
  assert.equal(await run(samePage, 0.78), "DONE e1,e2"); // same URL: only the 0.8 bar ends the Step
});
