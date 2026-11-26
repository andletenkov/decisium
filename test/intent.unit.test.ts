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

// Where an Action step ends (scripts/bench-owner.ts): once it has acted, Jev says which Scenario line the next element
// serves; another line ends the Step before acting, whatever the page or the wording.
const owned = async (
  owner: "this" | "other" | undefined,
  scenario = { lines: ["I continue", "I finish the order"], index: 0 },
) => {
  const { parseSnapshot, withPage } = await import("../src/observation.ts");
  const { runStep } = await import("../src/runner.ts");
  // SauceDemo "I continue": Continue opened the overview, done 0.3, and Jev leaned to Finish (the next Step's).
  const form = withPage(parseSnapshot(`- button "Continue" [ref=e1]`), "https://x.dev/step-one", "Shop");
  const overview = withPage(parseSnapshot(`- button "Finish" [ref=e2]`), "https://x.dev/step-two", "Shop");
  const complete = withPage(parseSnapshot(`- button "Back Home" [ref=e3]`), "https://x.dev/complete", "Shop");
  const sure = (choice: string) => ({ choice, probabilities: { [choice]: 0.95, other: 0.05 } });
  let obs = form;
  const did: string[] = [];
  const asked: string[] = [];
  const d = {
    turn: async (_s: string, o: typeof form) => ({
      done: o === complete ? 0.9 : o === form ? 0 : 0.3,
      target: sure(o.elements[0].ref),
    }),
    ...(owner && {
      owner: async (_s: string, _o: unknown, recent: string[], next: { line: string }) => {
        asked.push(`${next.line} after ${recent.length}`);
        return sure(owner);
      },
    }),
  } as unknown as Decider;
  const rt = {
    actionStep: (f: () => Promise<unknown>) => f(),
    observe: async () => obs,
    execute: async (a: { ref?: string }) => {
      did.push(a.ref!);
      obs = obs === form ? overview : complete;
    },
    waitForChange: async () => false,
  };
  const { outcome } = await runStep("I continue", rt as any, d, () => {}, false, undefined, undefined, scenario);
  return `${outcome} ${did.join(",")} | ${asked.join("; ")}`;
};

test("runner: an Action step ends before an element Jev says another Scenario line asks for", async () => {
  assert.equal(await owned("other"), 'DONE e1 | button "Finish" after 1');
  assert.equal(await owned("this"), 'DONE e1,e2 | button "Finish" after 1');
});

test("runner: where a Step ends is not asked before it acted, alone in its Scenario, or without the question", async () => {
  assert.equal(await owned("other", { lines: ["I continue"], index: 0 }), "DONE e1,e2 | ");
  assert.equal(await owned(undefined), "DONE e1,e2 | ");
});

test("runner: the next Step's element ends the Step even when Jev splits it with none (no gate before)", async () => {
  const { parseSnapshot } = await import("../src/observation.ts");
  const { runStep } = await import("../src/runner.ts");
  // TodoMVC "I add a todo": Enter added it, and Jev split 53/45 between the field and "none": AMBIGUOUS before.
  const empty = parseSnapshot(`- textbox "What needs to be done?" [ref=e1]`);
  const filled = parseSnapshot(`- textbox "What needs to be done?" [active] [ref=e1]: Call mom`);
  const added = parseSnapshot(`- textbox "What needs to be done?" [ref=e1]\n- listitem [ref=e2]: Call mom`);
  const sure = (choice: string) => ({ choice, probabilities: { [choice]: 0.95, other: 0.05 } });
  let obs = empty;
  const did: string[] = [];
  const d = {
    turn: async (_s: string, o: typeof empty) => ({
      done: 0.2,
      action: sure(o === filled ? "enter" : "type"),
      target: o === added ? { choice: "e1", probabilities: { e1: 0.53, none: 0.45 } } : sure("e1"),
    }),
    value: async () => sure("Call mom"),
    owner: async (_s: string, o: typeof empty) => sure(o === added ? "other" : "this"),
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
  const lines = { lines: ['I add a todo "Call mom"', 'I add a todo "Buy milk"'], index: 0 };
  const { outcome } = await runStep(
    'I add a todo "Call mom"',
    rt as any,
    d,
    () => {},
    false,
    undefined,
    undefined,
    lines,
  );
  assert.equal(`${outcome} ${did.join(",")}`, "DONE TYPE,ENTER");
});

test("cassette: where a Step ends is recorded and replayed; older recordings answer it from what their run did", async () => {
  const { parseSnapshot } = await import("../src/observation.ts");
  const obs = parseSnapshot(`- button "Finish" [ref=e2]`);
  const el = obs.elements[0];
  const lines = { lines: ["I continue", "I finish the order"], index: 0 };
  const p = path(),
    calls = { n: 0 };
  const liveOwner = {
    turn: async () => ({ done: 0.3, target: { choice: "e2", probabilities: { e2: 1 } } }),
    owner: async () => {
      calls.n++;
      return { choice: "other", probabilities: { this: 0.1, other: 0.9 } };
    },
  } as unknown as Decider;
  const rec = new Cassette(p, "m", "new");
  const d = rec.step("S: I continue", liveOwner);
  await d.turn("I continue", obs, ["CLICK"]);
  assert.equal((await d.owner!("I continue", obs, ["CLICK"], el, "click", lines)).choice, "other");
  d.done(true);
  rec.save();
  const play = new Cassette(p, "m", "none").step("S: I continue", liveOwner);
  await play.turn("I continue", obs, ["CLICK"]);
  assert.equal((await play.owner!("I continue", obs, ["CLICK"], el, "click", lines)).choice, "other");
  assert.equal(calls.n, 1);

  // Recorded before the question: a Turn followed by another was acted on (this); the last one ended the Step there
  // when done reached the after-action bar (other), else it was acted on.
  const t = (done: number) => ({ done, target: [[{ role: "button", name: "Finish", container: "" }, 1]] });
  const old = (turns: unknown[]) => {
    writeFileSync(p, JSON.stringify({ model: "m", entries: { "S: I continue": { turns } } }));
    return new Cassette(p, "m", "none").step("S: I continue", liveOwner);
  };
  const answer = async (turns: unknown[], i: number) => {
    const o = old(turns);
    for (let k = 0; k <= i; k++) await o.turn("I continue", obs, ["CLICK"]);
    return (await o.owner!("I continue", obs, ["CLICK"], el, "click", lines)).choice;
  };
  assert.equal(await answer([t(0.1), t(0.6)], 0), "this");
  assert.equal(await answer([t(0.1), t(0.6)], 1), "other");
  assert.equal(await answer([t(0.1), t(0.3)], 1), "this");
  assert.equal(calls.n, 1);
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

test("scenarioLines: only Action steps are lines; the running one is found among them", async () => {
  const { scenarioLines } = await import("../src/step.ts");
  const steps = [
    { kind: "action" as const, text: "I collapse the section" },
    { kind: "assertion" as const, text: "the toggle should be collapsed" },
    { kind: "attempt" as const, text: "I try to open it" },
  ];
  assert.deepEqual(scenarioLines(steps, 2), { lines: ["I collapse the section", "I try to open it"], index: 1 });
  assert.equal(scenarioLines(steps, 1).index, -1);
});

test("ModelDecider.owner: one answer per line, positioned, folded to this/other by the running line", async () => {
  const { ModelDecider } = await import("../src/model-decider.ts");
  const { parseSnapshot } = await import("../src/observation.ts");
  const obs = parseSnapshot(`- button "Next" [ref=e1]`);
  let asked: Record<string, string> = {};
  const provider = {
    decide: async (req: { questions: { owner: { criteria: Record<string, string> } } }) => {
      asked = req.questions.owner.criteria;
      return { answers: { owner: { choice: "line 2", probabilities: { "line 1": 0.3, "line 2": 0.7 } } } };
    },
  };
  const jev = new ModelDecider(provider as never);
  const lines = { lines: ['I click "Next"', 'I click "Next"'], index: 0 };
  const a = await jev.owner(lines.lines[0], obs, ["CLICK"], obs.elements[0], "click", lines);
  assert.deepEqual(a, { choice: "other", probabilities: { this: 0.3, other: 0.7 } });
  assert.deepEqual(asked, { "line 1": 'line 1 (this Step): I click "Next"', "line 2": 'line 2: I click "Next"' });
});

test("cassette: an older last Turn that acted and ended on its effect (toggle, drag, pinned) answers this", async () => {
  const { parseSnapshot } = await import("../src/observation.ts");
  const obs = parseSnapshot(
    `- button "Open" [ref=e1]\n- checkbox "Remember me" [ref=e2]\n- img "Card" [draggable] [ref=e3]`,
  );
  const lines = { lines: ["I open the form", "I tick remember me"], index: 0 };
  const p = path();
  const live = { owner: async () => assert.fail("replay must not ask") } as unknown as Decider;
  const answer = async (turn: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const t = { done: 0.6, target: [[{ role: "button", name: "Open", container: "" }, 1]] };
    writeFileSync(p, JSON.stringify({ model: "m", entries: { "S: s": { turns: [t, { ...t, ...turn }], ...extra } } }));
    const d = new Cassette(p, "m", "none").step("S: s", { ...live, turn: async () => assert.fail() } as Decider);
    await d.turn("s", obs, []);
    await d.turn("s", obs, ["CLICK"]);
    return (await d.owner!("s", obs, ["CLICK"], obs.elements[0], "click", lines)).choice;
  };
  assert.equal(await answer({}), "other"); // a button at done 0.6: it ended there before acting
  assert.equal(await answer({ target: [[{ role: "checkbox", name: "Remember me", container: "" }, 1]] }), "this");
  const card = [[{ role: "img", name: "Card", container: "" }, 1]];
  assert.equal(await answer({ target: card, action: [["drag", 1]] }), "this");
  assert.equal(await answer({}, { pinned: [{ turn: 2 }] }), "this");
});
