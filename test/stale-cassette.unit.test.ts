// A cassette is a cache, never a judge (issue #90): a recording that no longer fits the page costs a Jev call, never a
// failed Step, and a Step that does not reach DONE or PASSED never changes the cassette.
import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Cassette, repairsOf } from "../src/cassette.ts";
import type { Assessment, Decider, Pick } from "../src/decision.ts";
import { executeStep, type StepContext } from "../src/execute.ts";
import { type Observation, parseSnapshot } from "../src/observation.ts";
import type { Runtime } from "../src/runner.ts";

const sure = (choice: string): Pick => ({ choice, probabilities: { [choice]: 1 } });
const tmp = () => `${mkdtempSync(`${tmpdir()}/stale-`)}/c.cassette.json`;
const runtime = (snapshot: string): Runtime => {
  const obs = parseSnapshot(snapshot);
  return {
    actionStep: (run) => run(),
    observe: async () => obs,
    execute: async () => {},
    waitForChange: async () => false,
  };
};

/** A Decider that answers checks with `answer(obs)` and counts its calls; other questions are not used. */
function jev(answer: (obs: Observation) => Partial<Assessment>) {
  const calls: string[] = [];
  const unused = async () => {
    throw new Error("not used");
  };
  const live = {
    turn: unused,
    value: unused,
    drop: unused,
    dialog: unused,
    recall: unused,
    async assess(_step: string, obs: Observation) {
      calls.push("assess");
      return {
        kind: sure("presence"),
        negated: sure("no"),
        subject: sure("none"),
        area: sure("page"),
        state: sure("enabled"),
        ...answer(obs),
      };
    },
  } as unknown as Decider;
  return { live, calls };
}

/** Runs the check and saves the cassette, as the end of a run does. */
async function check(text: string, rt: Runtime, live: Decider, cassette: Cassette, runId?: string) {
  const r = await executeStep(text, {
    rt,
    live,
    cassette,
    key: "S: check",
    kind: "assertion",
    arg: {},
    earlier: {},
    log: () => {},
    ...(runId ? { generated: { "{{decisium.runId}}": runId } } : {}),
  } satisfies StepContext);
  cassette.save(r.outcome === "PASSED");
  return r;
}

/** A value check about the `generic` that shows `text`, as Jev resolved it in issue #90. */
const holding = (text: string) => (obs: Observation) => ({
  kind: sure("value"),
  subject: sure(obs.readable.find((e) => e.role === "generic" && e.text.includes(text))?.ref ?? "none"),
});

/** The app shows a generated value in a form Decisium cannot know: any case, any separators, cut, or wrapped. */
const transforms: ((id: string) => string)[] = [
  (id) => id,
  (id) => id.toLowerCase(),
  (id) => id.toUpperCase(),
  (id) => id.replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
  (id) => id.slice(0, 6),
  (id) => `[${id}]`,
  (id) => Buffer.from(id).toString("hex"),
];
const errorPage = (shown: string) =>
  [
    `- alert [ref=e1]:`,
    `  - generic [ref=e2]: Item 'item-${shown}' already exists`,
    `  - generic [ref=e5]: Pick another name`,
    `- region "Help" [ref=e3]:`,
    `  - generic [ref=e4]: Names must be unique`,
  ].join("\n");

test("a recording made on one run's text replays on any other run's text, in every record mode", async () => {
  for (const mode of ["none", "new"] as const)
    for (let i = 0; i < 20; i++) {
      const path = tmp();
      const recorder = jev(holding("already exists"));
      const show = transforms[randomInt(transforms.length)];
      const first = await check(
        `the error should say "already exists"`,
        runtime(errorPage(show(randomBytes(12).toString("base64url")))),
        recorder.live,
        new Cassette(path, "m", "new"),
      );
      assert.equal(first.outcome, "PASSED");
      const replayer = jev(holding("already exists"));
      const again = await check(
        `the error should say "already exists"`,
        runtime(errorPage(show(randomBytes(12).toString("base64url")))),
        replayer.live,
        new Cassette(path, "m", mode, undefined, true),
      );
      assert.equal(again.outcome, "PASSED", `${mode}: ${again.reason}`);
      assert.ok(replayer.calls.length <= 1, "Jev is asked again at most once per Step");
    }
});

/** Recorded when the help region showed the text: the check looks there, which no longer fits `errorPage`. */
const staleArea = async (path: string) => {
  const then = runtime(`- region "Help" [ref=e3]:\n  - generic [ref=e4]: Item already exists`);
  const r = await check(
    `"already exists" should appear`,
    then,
    jev(() => ({ area: sure("e3") })).live,
    new Cassette(path, "m", "new"),
  );
  assert.equal(r.outcome, "PASSED");
};

test("a replayed check that fails cannot switch to a passing area (issue #139)", async () => {
  const path = tmp();
  const rt = runtime(errorPage("x"));
  await staleArea(path);
  const before = readFileSync(path, "utf8");
  const live = jev(() => ({ area: sure("page") }));
  const c = new Cassette(path, "m", "none", undefined, true);
  const r = await check(`"already exists" should appear`, rt, live.live, c);
  assert.equal(r.outcome, "ASSERTION_FAILED");
  assert.equal(r.cassette, "replayed");
  assert.deepEqual(live.calls, []);
  assert.equal(existsSync(repairsOf(path)), false);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("a check that fails while recording is kept and replays as the same failure without a key, not UI_CHANGED", async () => {
  const path = tmp();
  const rt = runtime(errorPage("x"));
  const r = await check(`"Saved" should appear`, rt, jev(() => ({})).live, new Cassette(path, "m", "new"));
  assert.equal(r.outcome, "ASSERTION_FAILED");
  const live = jev(() => ({}));
  const again = await check(`"Saved" should appear`, rt, live.live, new Cassette(path, "m", "none", undefined, false));
  assert.equal(again.outcome, "ASSERTION_FAILED");
  assert.equal(again.cassette, "replayed");
  assert.deepEqual(live.calls, []);
});

test("a replayed check that fails waits for the page until its check deadline", async () => {
  const path = tmp();
  await staleArea(path);
  const timeout = 300;
  process.env.DECISIUM_CHECK_TIMEOUT = String(timeout);
  try {
    const obs = parseSnapshot(errorPage("x"));
    // The page keeps changing until the deadline, so a check that does not pass waits for all of it.
    const rt: Runtime = {
      actionStep: (run) => run(),
      observe: async () => obs,
      execute: async () => {},
      waitForChange: async (_since, ms = 0) => (await new Promise((ok) => setTimeout(ok, Math.min(ms, 50))), true),
    };
    const start = Date.now();
    const r = await check(
      `"already exists" should appear`,
      rt,
      jev(() => ({ area: sure("e3") })).live,
      new Cassette(path, "m", "none", undefined, true),
    );
    assert.equal(r.outcome, "ASSERTION_FAILED");
    assert.ok(Date.now() - start < timeout * 1.6, `waited ${Date.now() - start} ms`);
  } finally {
    delete process.env.DECISIUM_CHECK_TIMEOUT;
  }
});

test("answers Jev could not give are never written, and a heal that does not reach DONE or PASSED keeps the recording (issue #90, problem 2)", async () => {
  const rt = runtime(errorPage("x"));
  const spread: Pick = { choice: "page", probabilities: { page: 0.5, e3: 0.5 } }; // the areas disagree: AMBIGUOUS
  for (const mode of ["new", "all"] as const) {
    // A new Step
    const fresh = tmp();
    const c = new Cassette(fresh, "m", mode);
    const r = await check(`"already exists" should appear`, rt, jev(() => ({ area: spread })).live, c);
    assert.equal(r.outcome, "AMBIGUOUS");
    c.save();
    assert.equal(existsSync(fresh), false, mode);
  }
  // An old-format check that must be read again.
  const path = tmp();
  await staleArea(path);
  const legacy = JSON.parse(readFileSync(path, "utf8"));
  delete legacy.entries["S: check"].check.negated;
  const before = JSON.stringify(legacy);
  writeFileSync(path, before);
  const c = new Cassette(path, "m", "new");
  const r = await check(`"already exists" should appear`, rt, jev(() => ({ area: spread })).live, c);
  assert.equal(r.outcome, "AMBIGUOUS");
  c.save();
  assert.equal(readFileSync(path, "utf8"), before);
});

test("replay waits for a recorded element of a loading page before it asks Jev, like a Playwright spec", async () => {
  const { NotYet } = await import("../src/decision.ts");
  const path = tmp();
  const page = parseSnapshot(`- button "Save" [ref=e1]`);
  const calls: string[] = [];
  const live = {
    turn: async () => (calls.push("turn"), { done: 0, target: sure("e1"), action: sure("click") }),
  } as unknown as Decider;
  const rec = new Cassette(path, "m", "new");
  const w = rec.step("S: x", live);
  await w.turn("save", page, []);
  w.done(true);
  rec.save();
  const loading = parseSnapshot(`- progressbar [ref=e1]`);
  const d = new Cassette(path, "m", "none", undefined, true).step("S: x", live);
  const err = await d.turn("save", loading, []).catch((e: unknown) => e);
  assert.ok(err instanceof NotYet, "not on the page yet: wait, no Jev call");
  assert.deepEqual(calls, ["turn"]);
  err.giveUp!(); // the deadline passed
  assert.equal((await d.turn("save", loading, [])).target.choice, "e1");
  assert.deepEqual(calls, ["turn", "turn"]);
  assert.equal(d.done(true), "healed");
});

test("replay-only without a key cannot ask again: a stale recording fails and says how to fix it", async () => {
  const path = tmp();
  await staleArea(path); // recorded in the help region, which this page no longer has
  const live = jev(() => ({}));
  const r = await check(
    `"already exists" should appear`,
    runtime(`- alert [ref=e1]:\n  - generic [ref=e2]: Item already exists`),
    live.live,
    new Cassette(path, "m", "none", undefined, false),
  );
  assert.equal(r.outcome, "UI_CHANGED");
  assert.match(r.reason!, /re-record with --record all/);
  assert.deepEqual(live.calls, []);
});

test("the runId the app shows lowercased or slugified replays without a key on another run (issue #90, problem 3)", async () => {
  const forms: ((id: string) => string)[] = [
    (id) => id.toLowerCase(),
    (id) =>
      `name-${id}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-$/, ""), // a slug of "Name <id>"
    (id) => id.toLowerCase().replace(/[^a-z0-9]/g, ""),
  ];
  for (const show of forms)
    for (let i = 0; i < 10; i++) {
      const path = tmp();
      const [a, b] = [randomBytes(12).toString("base64url"), randomBytes(12).toString("base64url")];
      const first = await check(
        `the error should say "already exists"`,
        runtime(errorPage(show(a))),
        jev(holding("already exists")).live,
        new Cassette(path, "m", "new"),
        a,
      );
      assert.equal(first.outcome, "PASSED");
      const live = jev(holding("already exists"));
      const again = await check(
        `the error should say "already exists"`,
        runtime(errorPage(show(b))),
        live.live,
        new Cassette(path, "m", "none", undefined, false),
        b,
      );
      assert.equal(again.outcome, "PASSED", `${show(a)} -> ${show(b)}: ${again.reason}`);
      assert.deepEqual(live.calls, []);
    }
});

test("what a check reads is recorded by structure, never by its text: it replays on any run's text (issue #91)", async () => {
  const path = tmp();
  const r = await check(
    `the error should say "already exists"`,
    runtime(errorPage("x")),
    jev(holding("already exists")).live,
    new Cassette(path, "m", "new"),
  );
  assert.equal(r.outcome, "PASSED");
  const subject = JSON.parse(readFileSync(path, "utf8")).entries["S: check"].check.subject;
  // The first of the alert's two lines: no text of either is in the recording.
  assert.deepEqual(subject, [
    [{ role: "generic", name: "", container: "", scope: { role: "alert", name: "", container: "" }, nth: 0, of: 2 }, 1],
  ]);
  const live = jev(() => ({}));
  const again = await check(
    `the error should say "already exists"`,
    runtime(errorPage("y")),
    live.live,
    new Cassette(path, "m", "none", undefined, false),
  );
  assert.equal(again.outcome, "PASSED", again.reason ?? "");
  assert.deepEqual(live.calls, []);
});

test("a negated check on one line of an alert reads that line, not the alert (issue #91)", async () => {
  const path = tmp();
  const step = `the error should not say "Pick another"`;
  const first = await check(
    step,
    runtime(errorPage("x")),
    jev((obs) => ({ ...holding("already exists")(obs), negated: sure("yes") })).live,
    new Cassette(path, "m", "new"),
  );
  assert.equal(first.outcome, "PASSED", first.reason ?? "");
  const again = await check(
    step,
    runtime(errorPage("y")),
    jev(() => ({})).live,
    new Cassette(path, "m", "none", undefined, false),
  );
  assert.equal(again.outcome, "PASSED", again.reason ?? "");
});

/** A knowledge base list that keeps growing between runs (issue #91, knowledge:78): `n` rows, one checkbox each. */
const kbList = (n: number) =>
  [
    `- region "Knowledge" [ref=r1]:`,
    `  - group "Knowledge bases" [ref=g1]:`,
    ...Array.from({ length: n }, (_, i) => [
      `    - generic [ref=w${i}]:`,
      `      - checkbox "KB ${i}" [${i === 0 ? "checked" : "unchecked"}] [ref=c${i}]`,
    ]).flat(),
  ].join("\n");

test("a recording holds only the answers its verdict read: a state check replays however the list around it grows", async () => {
  const path = tmp();
  const state = (obs: Observation) => ({
    kind: sure("state"),
    state: sure("checked"),
    subject: sure(obs.readable.find((e) => e.name === "KB 0")!.ref),
    // Where the check is: not read by a state check, and here partly a row only its position tells apart.
    area: { choice: "r1", probabilities: { r1: 0.73, w7: 0.1, page: 0.17 } },
  });
  const step = `the "KB 0" checkbox should be checked`;
  const first = await check(step, runtime(kbList(20)), jev(state).live, new Cassette(path, "m", "new"));
  assert.equal(first.outcome, "PASSED", first.reason ?? "");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).entries["S: check"].check.area, undefined);
  const live = jev(state);
  const again = await check(step, runtime(kbList(25)), live.live, new Cassette(path, "m", "none", undefined, false));
  assert.equal(again.outcome, "PASSED", again.reason ?? "");
  assert.deepEqual(live.calls, []);
});

test("Jev is asked live only once the page settled after an unsettled replay action (issue #133)", async () => {
  // --record none with a key: actions do not settle; the Observation right after one can still show the old page.
  let settled = false;
  const before = { ...parseSnapshot(errorPage("x")), unsettled: true as const };
  const after = parseSnapshot(`- region "Help" [ref=e3]:\n  - generic [ref=e4]: Item already exists`);
  const rt: Runtime = {
    actionStep: (run) => run(),
    observe: async () => (settled ? after : before),
    execute: async () => {},
    waitForChange: async () => false,
    settle: async () => {
      settled = true;
    },
  };
  const seen: string[] = [];
  const { live } = jev((obs) => {
    seen.push(obs.text);
    return holding("already exists")(obs);
  });
  const r = await check('"already exists" is shown', rt, live, new Cassette(tmp(), "m", "none", undefined, true));
  assert.equal(r.outcome, "PASSED");
  assert.deepEqual(seen, [after.text], "Jev never reads the unsettled page");
});

test("a live Turn after an unsettled replay action reads the settled page (issue #133)", async () => {
  let settled = false;
  const before = { ...parseSnapshot(`- button "Continue" [ref=e1]`), unsettled: true as const };
  const after = parseSnapshot(`- button "Finish" [ref=e9]`);
  const rt: Runtime = {
    actionStep: (run) => run(),
    observe: async () => (settled ? after : before),
    execute: async () => {},
    waitForChange: async () => false,
    settle: async () => {
      settled = true;
    },
  };
  const seen: string[] = [];
  const live = {
    async turn(_s: string, obs: Observation) {
      seen.push(obs.text);
      return { done: 1, target: sure("none") };
    },
  } as unknown as Decider;
  const r = await executeStep("I continue", {
    rt,
    live,
    cassette: new Cassette(tmp(), "m", "none", undefined, true),
    key: "S: I continue",
    kind: "action",
    arg: {},
    earlier: {},
    log: () => {},
  });
  assert.equal(r.outcome, "DONE");
  assert.deepEqual(seen, [after.text]);
});

test("a recording is judged on the settled page, not on the unsettled one after a replay action (issue #133)", async () => {
  const path = tmp();
  const page = `- alert [ref=e1]:\n  - generic [ref=e2]: Item already exists`;
  await check(
    '"already exists" is shown',
    runtime(page),
    jev(holding("already exists")).live,
    new Cassette(path, "m", "new"),
  );
  let settled = false;
  const before = { ...parseSnapshot(`- button "Continue" [ref=e9]`), unsettled: true as const };
  const rt: Runtime = {
    actionStep: (run) => run(),
    observe: async () => (settled ? parseSnapshot(page) : before),
    execute: async () => {},
    // the page shows the action's effect: replay waits for its recorded target (NotYet), no Jev call
    waitForChange: async () => {
      settled = true;
      return true;
    },
    settle: async () => {
      settled = true;
    },
  };
  const again = jev(holding("already exists"));
  const r = await check('"already exists" is shown', rt, again.live, new Cassette(path, "m", "none", undefined, true));
  assert.equal(r.outcome, "PASSED");
  assert.deepEqual(again.calls, [], "replayed, no Jev call");
});

test("a value missing from the recording on an unsettled page asks the whole Turn again (issue #133)", async () => {
  const path = tmp();
  const field = `- textbox "First Name" [ref=e1]`;
  const step = 'I enter "Ada" into First Name';
  const key = `S: ${step}`;
  const asked: string[] = [];
  const turn = (n: number) => async (_s: string, obs: Observation) => {
    asked.push(`turn ${n}: ${obs.text}`);
    return n === 1 && !asked.some((a) => a.startsWith("value"))
      ? { done: 0, target: sure("e1"), action: sure("type") }
      : { done: 1, target: sure("none") };
  };
  const decider = (n: number) =>
    ({
      turn: turn(n),
      async value(_s: string, obs: Observation) {
        asked.push(`value: ${obs.text}`);
        return sure("Ada");
      },
    }) as unknown as Decider;
  const run = (rt: Runtime, live: Decider, cassette: Cassette) =>
    executeStep(step, { rt, live, cassette, key, kind: "action", arg: {}, earlier: {}, log: () => {} });
  const recorder = new Cassette(path, "m", "new");
  assert.equal((await run(runtime(field), decider(1), recorder)).outcome, "DONE");
  recorder.save();
  // The recording loses its value: the replayed Turn's next question must go live.
  const file = JSON.parse(readFileSync(path, "utf8"));
  delete file.entries[key].turns[0].value;
  writeFileSync(path, JSON.stringify(file));
  asked.length = 0;

  let settled = false;
  const before = { ...parseSnapshot(field), unsettled: true as const };
  const after = parseSnapshot(`${field}\n- generic [ref=e2]: Step two`);
  const rt: Runtime = {
    actionStep: (r) => r(),
    observe: async () => (settled ? after : before),
    execute: async () => {},
    waitForChange: async () => false,
    settle: async () => {
      settled = true;
    },
  };
  const r = await run(rt, decider(2), new Cassette(path, "m", "none", undefined, true));
  assert.equal(r.outcome, "DONE");
  // Turn 1 replayed twice (before and after settling), its value asked live once on the settled page, then turn 2 live.
  assert.deepEqual(asked, [`value: ${after.text}`, `turn 2: ${after.text}`]);
});
