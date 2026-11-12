// A cassette is a cache, never a judge (issue #90): a recording that no longer fits the page costs a Jev call, never a
// failed Step, and a Step that does not reach DONE or PASSED never changes the cassette.
import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Cassette } from "../src/cassette.ts";
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
async function check(text: string, rt: Runtime, live: Decider, cassette: Cassette) {
  const r = await executeStep(text, {
    rt,
    live,
    cassette,
    key: "S: check",
    kind: "assertion",
    arg: {},
    earlier: {},
    log: () => {},
  } satisfies StepContext);
  cassette.save();
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

test("a replayed check that fails is asked again once; a pass replaces the recording", async () => {
  const path = tmp();
  const rt = runtime(errorPage("x"));
  await staleArea(path);
  const live = jev(() => ({ area: sure("page") }));
  const c = new Cassette(path, "m", "none", undefined, true);
  const r = await check(`"already exists" should appear`, rt, live.live, c);
  assert.equal(r.outcome, "PASSED");
  assert.equal(r.cassette, "healed");
  assert.deepEqual(live.calls, ["assess"]);
  c.save();
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).entries["S: check"].check.area, [["page", 1]]);
});

test("a check that still fails when asked again is a real failure and leaves the cassette unchanged", async () => {
  const path = tmp();
  const rt = runtime(errorPage("x"));
  await staleArea(path);
  const before = readFileSync(path, "utf8");
  const live = jev(() => ({ area: sure("e3") }));
  const c = new Cassette(path, "m", "new");
  const r = await check(`"already exists" should appear`, rt, live.live, c);
  assert.equal(r.outcome, "ASSERTION_FAILED");
  assert.deepEqual(live.calls, ["assess"]);
  c.save();
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

test("a replayed check that fails waits for the page once: asking Jev again does not restart the wait", async () => {
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
  // A heal
  const path = tmp();
  await staleArea(path);
  const before = readFileSync(path, "utf8");
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
  await check(
    `the error should say "already exists"`,
    runtime(errorPage("abc")),
    jev(holding("already exists")).live,
    new Cassette(path, "m", "new"),
  );
  const live = jev(holding("already exists"));
  const r = await check(
    `the error should say "already exists"`,
    runtime(errorPage("zz-other")),
    live.live,
    new Cassette(path, "m", "none", undefined, false),
  );
  assert.notEqual(r.outcome, "PASSED");
  assert.match(r.reason!, /re-record with --record new, or provide a model key/);
  assert.deepEqual(live.calls, []);
});
