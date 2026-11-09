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

test("runner: after opening a new page, a field the Step gives nothing to type belongs to the next Step", async () => {
  const { parseSnapshot, withPage } = await import("../src/observation.ts");
  const { runStep } = await import("../src/runner.ts");
  // Spanish "empiezo el pago": Checkout opened the form, done 0.38, Jev leaned to First Name: AMBIGUOUS.
  const cart = withPage(parseSnapshot(`- button "Checkout" [ref=e1]`), "https://x.dev/cart", "Shop");
  const form = withPage(parseSnapshot(`- textbox "First Name" [ref=e2]`), "https://x.dev/checkout", "Shop");
  const sure = (choice: string) => ({ choice, probabilities: { [choice]: 0.95, other: 0.05 } });
  let obs = cart;
  const d = {
    turn: async (_s: string, o: typeof cart) => ({ done: o === cart ? 0 : 0.38, target: sure(o.elements[0].ref) }),
  } as unknown as Decider;
  const rt = {
    actionStep: (f: () => Promise<unknown>) => f(),
    observe: async () => obs,
    execute: async () => {
      obs = form;
    },
    waitForChange: async () => false,
  };
  assert.equal((await runStep("empiezo el pago", rt as any, d, () => {})).outcome, "DONE");
});

test("runner: an Action step whose typed value was submitted onto the page stops instead of typing it again", async () => {
  const { parseSnapshot } = await import("../src/observation.ts");
  const { runStep } = await import("../src/runner.ts");
  // TodoMVC "I add a todo": Enter added it (field emptied, the text appeared in the list), done 0.63, and Jev still
  // leaned to the field: it typed the todo again, or split 53/45 with "none" and failed AMBIGUOUS.
  const empty = parseSnapshot(`- textbox "What needs to be done?" [ref=e1]`);
  const filled = parseSnapshot(`- textbox "What needs to be done?" [active] [ref=e1]: Call mom`);
  const added = parseSnapshot(`- textbox "What needs to be done?" [ref=e1]\n- listitem [ref=e2]: Call mom`);
  const sure = (choice: string) => ({ choice, probabilities: { [choice]: 0.95, other: 0.05 } });
  const run = async (done: number) => {
    let obs = empty;
    const did: string[] = [];
    const d = {
      turn: async (_s: string, o: typeof empty) => ({
        done: o === added ? done : 0,
        action: sure(o === filled ? "enter" : "type"),
        target: o === added ? { choice: "e1", probabilities: { e1: 0.53, none: 0.45 } } : sure("e1"),
      }),
      value: async () => sure("Call mom"),
    } as unknown as Decider;
    const rt = {
      actionStep: (f: () => Promise<unknown>) => f(),
      observe: async () => obs,
      execute: async (a: { verb: string }) => {
        did.push(a.verb);
        obs = a.verb === "TYPE" ? filled : added;
      },
      waitForChange: async () => false,
    };
    const { outcome } = await runStep('I add a todo "Call mom"', rt as any, d, () => {});
    return `${outcome} ${did.join(",")}`;
  };
  assert.equal(await run(0.63), "DONE TYPE,ENTER");
  assert.equal(await run(0.2), "AMBIGUOUS TYPE,ENTER"); // Jev thinks it is not done: the gate still applies
});

test("runner: a typed value still in its field is not submitted, even when suggestions show it", async () => {
  const { parseSnapshot } = await import("../src/observation.ts");
  const { runStep } = await import("../src/runner.ts");
  const empty = parseSnapshot(`- textbox "Search" [ref=e1]`);
  const suggesting = parseSnapshot(`- textbox "Search" [active] [ref=e1]: Ada\n- option "Ada Lovelace" [ref=e2]`);
  const sure = (choice: string) => ({ choice, probabilities: { [choice]: 0.95, other: 0.05 } });
  let obs = empty;
  const did: string[] = [];
  const d = {
    turn: async (_s: string, o: typeof empty) => ({
      done: o === empty ? 0 : 0.6,
      action: sure(o === empty ? "type" : "enter"),
      target: o === empty ? sure("e1") : { choice: "e1", probabilities: { e1: 0.53, none: 0.45 } },
    }),
    value: async () => sure("Ada"),
  } as unknown as Decider;
  const rt = {
    actionStep: (f: () => Promise<unknown>) => f(),
    observe: async () => obs,
    execute: async (a: { verb: string }) => {
      did.push(a.verb);
      obs = suggesting;
    },
    waitForChange: async () => false,
  };
  const { outcome } = await runStep('I search for "Ada" and submit the search', rt as any, d, () => {});
  assert.equal(`${outcome} ${did.join(",")}`, "AMBIGUOUS TYPE");
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

test("runner: Enter split between the focused field and the page is one choice: the field", async () => {
  const { parseSnapshot } = await import("../src/observation.ts");
  const { runStep } = await import("../src/runner.ts");
  // TodoMVC "I add a todo": typed, then enter 0.92 with the target field 0.48 / page 0.43: AMBIGUOUS.
  const empty = parseSnapshot(`- textbox "What needs to be done?" [ref=e1]`);
  const filled = parseSnapshot(`- textbox "What needs to be done?" [active] [ref=e1]: Call mom`);
  const added = parseSnapshot(`- textbox "What needs to be done?" [active] [ref=e1]\n- listitem [ref=e2]: Call mom`);
  const sure = (choice: string) => ({ choice, probabilities: { [choice]: 0.95, other: 0.05 } });
  let obs = empty;
  const did: string[] = [];
  const d = {
    turn: async (_s: string, o: typeof empty) =>
      o === empty
        ? { done: 0, action: sure("type"), target: sure("e1") }
        : o === filled
          ? {
              done: 0.12,
              action: { choice: "enter", probabilities: { enter: 0.92, type: 0.08 } },
              target: { choice: "e1", probabilities: { e1: 0.48, page: 0.43, none: 0.09 } },
            }
          : { done: 0.9, target: sure("none") },
    value: async () => sure("Call mom"),
  } as unknown as Decider;
  const rt = {
    actionStep: (f: () => Promise<unknown>) => f(),
    observe: async () => obs,
    execute: async (a: { verb: string }) => {
      did.push(a.verb);
      obs = a.verb === "TYPE" ? filled : added;
    },
    waitForChange: async () => false,
  };
  const { outcome } = await runStep('I add a todo "Call mom"', rt as any, d, () => {});
  assert.equal(`${outcome} ${did.join(",")}`, "DONE TYPE,ENTER");
});
