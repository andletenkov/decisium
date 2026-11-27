// The assertion contract through its public interface, runAssertion (issue #81): one temporal policy, live and replay
// alike, one Jev request per look at the page, and no ordinary pass resting on a model's answer to "does it pass?".
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Cassette, UiChanged } from "../src/cassette.ts";
import type { Assessment, Decider, Pick } from "../src/decision.ts";
import { executeStep } from "../src/execute.ts";
import { parseSnapshot, type Observation } from "../src/observation.ts";
import { runAssertion, type Runtime } from "../src/runner.ts";

const sure = (choice: string): Pick => ({ choice, probabilities: { [choice]: 1 } });
const unused = async (): Promise<never> => {
  throw new Error("not used");
};

/** Screens shown in turn: each waitForChange moves to the next one, until the last (then the page is idle). */
function screens(...shown: Observation[]): Runtime & { looked: number } {
  let i = 0;
  const rt = {
    looked: 0,
    actionStep: <T>(run: () => Promise<T>) => run(),
    observe: async () => {
      rt.looked++;
      return shown[i];
    },
    execute: async () => {},
    waitForChange: async () => i < shown.length - 1 && !!++i,
  };
  return rt;
}

// The campaign list after a delete that never happened (refactor bench): it takes a while to load.
const loading = parseSnapshot(`- main [ref=e1]:
  - heading "Campaigns" [level=1] [ref=e2]
  - paragraph [ref=e3]: Loading campaigns…`);
const list = (...names: string[]) =>
  parseSnapshot(`- main [ref=e1]:
  - heading "Campaigns" [level=1] [ref=e2]
  - table [ref=e4]:
    - row [ref=e5]:
      - columnheader "Name" [ref=e6]
${names.map((n, i) => `    - row [ref=r${i}]:\n      - cell "${n}" [ref=c${i}]`).join("\n")}`);
const inFlight = (obs: Observation): Observation => ({
  ...obs,
  loading: "the page is still loading (a request is in flight)",
});

/**
 * A correct model: the campaign list is the table once shown; before that `before` (the list is not on the screen).
 * `always`: a model that takes that area for the list whatever is shown.
 */
function model(before = "missing", always = false) {
  const asked = { judged: false };
  const d: Decider & { asked: typeof asked; assessed: number } = {
    turn: unused,
    value: unused,
    recall: unused,
    dialog: unused,
    drop: unused,
    asked,
    assessed: 0,
    async assess(_step, obs, judged): Promise<Assessment> {
      d.assessed++;
      asked.judged ||= judged;
      const table = obs.areas.find((e) => e.role === "table");
      return {
        kind: sure("presence"),
        negated: sure("yes"),
        subject: sure("none"),
        area: sure(table && !always ? table.ref : before),
        state: sure("disabled"),
      };
    },
  };
  return d;
}

const ABSENT = `"Spring Sale" should not appear in the campaign list`;
const run = (rt: Runtime, d: Decider, step = ABSENT) => runAssertion(step, rt, d, () => {});

test("runAssertion: an absence that holds on a loading screen waits for the loaded list (refactor bench)", async () => {
  // The list is not on the screen yet: no evidence, then the loaded list shows the campaign.
  const failed = await run(screens(loading, list("Autumn Sale", "Spring Sale")), model());
  assert.deepEqual(failed, {
    outcome: "ASSERTION_FAILED",
    reason: `"Spring Sale" is shown in table, expected it to be absent`,
  });
  assert.equal((await run(screens(loading, list("Autumn Sale")), model())).outcome, "PASSED");
  // Jev takes the main area for the list while it loads: that area is on the screen, but a request is in flight.
  const main = await run(screens(inFlight(loading), list("Autumn Sale", "Spring Sale")), model("e1"));
  assert.equal(main.outcome, "ASSERTION_FAILED");
});

test("runAssertion: evidence still missing at the deadline is UNVERIFIABLE, never a pass or a failure", async () => {
  // The app stays on the loading screen: nothing left that could change it.
  for (const negated of ["yes", "no"]) {
    const d = model();
    const assess = d.assess;
    d.assess = async (...args) => ({ ...(await assess(...args)), negated: sure(negated) });
    assert.deepEqual(await run(screens(loading), d), {
      outcome: "UNVERIFIABLE",
      reason: "the area the check names is not on this screen",
    });
  }
});

test("runAssertion: a request that ends without changing the page is looked at again, Jev is not asked again", async () => {
  const ready = list("Autumn Sale");
  let looks = 0;
  const rt: Runtime = {
    actionStep: (run) => run(),
    observe: async () => (looks++ ? ready : inFlight(ready)),
    execute: async () => {},
    waitForChange: async () => false,
  };
  const d = model();
  assert.equal((await run(rt, d)).outcome, "PASSED");
  assert.equal(looks, 2);
  assert.equal(d.assessed, 1);
});

test("runAssertion: looking again at an unchanged page while a request is in flight logs it once", async () => {
  const loadingList = inFlight(list("Autumn Sale"));
  let looks = 0;
  const rt: Runtime = {
    actionStep: (run) => run(),
    observe: async () => (++looks < 20 ? loadingList : list("Autumn Sale")),
    execute: async () => {},
    waitForChange: async () => false, // the page went quiet, the request did not end
  };
  const lines: string[] = [];
  assert.equal((await runAssertion(ABSENT, rt, model(), (l: string) => lines.push(l))).outcome, "PASSED");
  assert.equal(looks, 20);
  assert.equal(lines.filter((l) => l.includes("not known yet")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("  Kind:")).length, 1); // the same answer on every look
});

test("runAssertion: one Jev request per look at the page, never a question whether the check passes", async () => {
  const d = model();
  const status = parseSnapshot("- paragraph [ref=e1]: Status: Draft");
  const value: Decider = {
    ...d,
    assess: async (...args) => ({
      ...(await d.assess(...args)),
      kind: sure("value"),
      negated: sure("no"),
      subject: sure("e1"),
    }),
  };
  const r = await run(screens(status), value, `the status should be "Scheduled"`);
  assert.deepEqual(r, {
    outcome: "ASSERTION_FAILED",
    reason: `expected "Scheduled", but paragraph shows "Status: Draft"`,
  });
  assert.equal(d.assessed, 1);
  assert.equal(d.asked.judged, false);
});

const tmp = () => `${mkdtempSync(`${tmpdir()}/assertion-unit-`)}/t.cassette.json`;
const noJev: Decider = {
  turn: unused,
  value: unused,
  assess: unused,
  recall: unused,
  dialog: unused,
  drop: unused,
};

const records = (alphaStatus: string, alphaButton: string) =>
  parseSnapshot(`- table [ref=e1]:
  - row [ref=r1]:
    - cell "Alpha" [ref=n1]
    - cell [ref=c1]:
      - paragraph [ref=s1]: ${alphaStatus}
    - button "${alphaButton}" [ref=b1]
  - row [ref=r2]:
    - cell "Beta" [ref=n2]
    - cell [ref=c2]:
      - paragraph [ref=s2]: Complete
    - button "Open" [ref=b2]`);

function execute(text: string, kind: "assertion" | "action", rt: Runtime, live: Decider, cassette: Cassette) {
  return executeStep(text, { rt, live, cassette, key: `S: ${text}`, kind, arg: {}, earlier: {}, log: () => {} });
}

test("executeStep: a replayed comparison fails on Alpha without asking Jev to pick Beta", async () => {
  const path = tmp();
  const rec = new Cassette(path, "m", "new");
  const step = `Alpha's status should be "Complete"`;
  const assesses = (ref: string): Assessment => ({
    kind: sure("value"),
    negated: sure("no"),
    subject: sure(ref),
    area: sure("page"),
    state: sure("enabled"),
  });
  const recorded = await execute(
    step,
    "assertion",
    screens(records("Complete", "Open")),
    {
      ...noJev,
      assess: async () => assesses("s1"),
    },
    rec,
  );
  assert.equal(recorded.outcome, "PASSED");
  assert.equal(recorded.cassette, "recorded");
  rec.save();

  let asked = 0;
  const live: Decider = {
    ...noJev,
    assess: async () => {
      asked++;
      return assesses("s2");
    },
  };
  const result = await execute(
    step,
    "assertion",
    screens(records("Failed", "Open")),
    live,
    new Cassette(path, "m", "new"),
  );
  assert.equal(result.outcome, "ASSERTION_FAILED");
  assert.match(result.reason ?? "", /Failed/);
  assert.equal(result.cassette, "replayed");
  assert.equal(asked, 0);

  const missing = parseSnapshot(`- paragraph [ref=e1]: Complete`);
  for (const mode of ["new", "none"] as const) {
    const outcome = await execute(
      step,
      "assertion",
      screens(missing),
      live,
      new Cassette(path, "m", mode, undefined, true),
    );
    assert.equal(outcome.outcome, "UI_CHANGED");
    assert.equal(asked, 0);
    const transient = await execute(
      step,
      "assertion",
      screens(missing, records("Complete", "Open")),
      noJev,
      new Cassette(path, "m", mode, undefined, true),
    );
    assert.equal(transient.outcome, mode === "none" ? "PASSED" : "UI_CHANGED");
  }
});

test("executeStep: replay cannot replace a missing recalled expectation", async () => {
  const path = tmp();
  const rec = new Cassette(path, "m", "new");
  const text = "the saved name should appear";
  const check = (earlier: Record<string, string>, cassette: Cassette, live: Decider) =>
    executeStep(text, {
      rt: screens(list("Alpha", "Beta")),
      live,
      cassette,
      key: `S: ${text}`,
      kind: "assertion",
      arg: {},
      earlier,
      log: () => {},
    });
  const live: Decider = {
    ...model("page", true),
    recall: async () => sure("Alpha"),
    assess: async () => ({
      kind: sure("presence"),
      negated: sure("no"),
      subject: sure("none"),
      area: sure("page"),
      state: sure("enabled"),
    }),
  };
  assert.equal((await check({ Alpha: "the earlier Step" }, rec, live)).outcome, "PASSED");
  rec.save();
  const changedMemory: Record<string, string>[] = [{ Beta: "the earlier Step" }, {}];
  for (const earlier of changedMemory) {
    const result = await check(earlier, new Cassette(path, "m", "new"), noJev);
    assert.equal(result.outcome, "UI_CHANGED");
    assert.match(result.reason ?? "", /recorded earlier value "Alpha"/);
  }
});

test("executeStep: unrelated scenario memory does not invalidate a recorded state check", async () => {
  const path = tmp();
  const rec = new Cassette(path, "m", "new");
  const text = "the Save button should be disabled";
  const check = (cassette: Cassette, live: Decider, earlier: Record<string, string>) =>
    executeStep(text, {
      rt: screens(parseSnapshot(`- button "Save" [disabled] [ref=e1]`)),
      live,
      cassette,
      key: `S: ${text}`,
      kind: "assertion",
      arg: {},
      earlier,
      log: () => {},
    });
  const live: Decider = {
    ...noJev,
    assess: async () => ({
      kind: sure("state"),
      negated: sure("no"),
      subject: sure("e1"),
      area: sure("page"),
      state: sure("disabled"),
    }),
  };
  assert.equal((await check(rec, live, {})).outcome, "PASSED");
  rec.save();
  const result = await check(new Cassette(path, "m", "new"), noJev, { Beta: "the earlier Step" });
  assert.equal(result.outcome, "PASSED");
  assert.equal(result.cassette, "replayed");
});

test("executeStep: action repair clicks the renamed Alpha button, not Beta's old label", async () => {
  const path = tmp();
  const rec = new Cassette(path, "m", "new");
  const step = `I open "Alpha"`;
  const clicks: (string | undefined)[] = [];
  const rt = (label: string): Runtime => ({
    ...screens(records("Complete", label)),
    execute: async (a) => {
      clicks.push(a.ref);
    },
  });
  const live: Decider = {
    ...noJev,
    turn: async (_step, _obs, recent) =>
      recent.length ? { done: 1, target: sure("none") } : { done: 0, target: sure("b1"), action: sure("click") },
  };
  assert.equal((await execute(step, "action", rt("Open"), live, rec)).outcome, "DONE");
  assert.deepEqual(clicks.splice(0), ["b1"]);
  rec.save();

  const result = await execute(step, "action", rt("View"), live, new Cassette(path, "m", "new"));
  assert.equal(result.outcome, "DONE");
  assert.equal(result.cassette, "healed");
  assert.deepEqual(clicks, ["b1"]);
});

test("runAssertion: replay applies the same evidence rules to the recorded resolutions", async () => {
  // The recorded list is not on the loading screen; the recorded main area is, while a request is in flight.
  for (const [before, first, always] of [
    ["missing", loading, false],
    ["e1", inFlight(loading), true],
  ] as const) {
    const path = tmp();
    const sequence = () => [first, list("Autumn Sale", "Spring Sale")];
    const live = await run(screens(...sequence()), model(before, always));
    assert.equal(live.outcome, "ASSERTION_FAILED", before);
    // Record the answers where Jev gave them, then replay them (no Jev) on the same loading screen.
    const rec = new Cassette(path, "m", "new");
    const writer = rec.step("S: x", model(before, always));
    await run(screens(...sequence()), writer);
    writer.done(true);
    rec.save();
    const replayer = new Cassette(path, "m", "none").step("S: x", noJev);
    const replayed = await run(screens(...sequence()), replayer);
    assert.deepEqual(replayed, live, before);
    assert.equal(replayer.done(true), "replayed", before);
  }
});

test("cassette: a check recorded before negation was its own answer is re-recorded, not replayed", async () => {
  const path = tmp();
  const ready = list("Autumn Sale");
  const rec = new Cassette(path, "m", "new");
  const writer = rec.step("S: x", model());
  const live = await run(screens(ready), writer);
  assert.equal(writer.done(true), "recorded");
  rec.save();
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(file.entries["S: x"].check.negated, sure("yes"));
  // As recorded before issue #81: the negation folded into the kind.
  file.entries["S: x"].check.kind = sure("absence");
  delete file.entries["S: x"].check.negated;
  writeFileSync(path, JSON.stringify(file));
  await assert.rejects(
    run(screens(ready), new Cassette(path, "m", "none").step("S: x", noJev)),
    (err) => err instanceof UiChanged && /recorded before negation was its own answer/.test(err.reason),
  );
  await assert.rejects(
    run(screens(ready), new Cassette(path, "m", "new").step("S: x", noJev)),
    (err) => err instanceof UiChanged && /re-record with --record all/.test(err.reason),
  );
  const replacement = new Cassette(path, "m", "all").step("S: x", model());
  assert.deepEqual(await run(screens(ready), replacement), live);
  assert.equal(replacement.done(true), "recorded");
});

test("Jev: a check's request asks for its meaning and references, a verdict only with --judged", async (t) => {
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");
  const { JevDecider } = await import("../src/jev.ts");
  const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test";
  const requests: {
    state: Record<string, unknown>;
    questions: Record<string, { type: string; criteria?: Record<string, string> }>;
  }[] = [];
  t.mock.method(TypeSafeClient.prototype, "systemOne", (async (request: (typeof requests)[number]) => {
    requests.push(request);
    // Contract-valid answers: a full distribution over the offered criteria, a noul in [0, 1].
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([q, question]) => {
        if (question.type === "noul") return [q, { noul: 0.9 }];
        const keys = Object.keys(question.criteria ?? {});
        return [q, { choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) => [k, i ? 0 : 1])) }];
      }),
    );
    return { model: "test", answers };
  }) as never);
  try {
    const jev = new JevDecider();
    const obs = parseSnapshot("- paragraph [ref=e1]: Status: Not Scheduled");
    assert.equal((await jev.assess('the status should be "Scheduled"', obs, false)).judged, undefined);
    assert.deepEqual(Object.keys(requests.at(-1)!.questions), [
      "kind",
      "negated",
      "scoped",
      "subject",
      "state",
      "area",
    ]);
    assert.equal((await jev.assess("the form looks complete", obs, true)).judged, 0.9);
    assert.ok("satisfied" in requests.at(-1)!.questions);
  } finally {
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
  }
});
