// The assertion contract through its public interface, runAssertion (issue #81): one temporal policy, live and replay
// alike, one Jev request per look at the page, and no ordinary pass resting on a model's answer to "does it pass?".
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Cassette, UiChanged } from "../src/cassette.ts";
import type { Assessment, Decider, Pick } from "../src/decision.ts";
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
  const healing = new Cassette(path, "m", "new").step("S: x", model());
  assert.deepEqual(await run(screens(ready), healing), live);
  assert.equal(healing.done(true), "healed");
});

test("Jev: a check's request asks for its meaning and references, a verdict only with --judged", async (t) => {
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");
  const { JevDecider } = await import("../src/jev.ts");
  const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test";
  const requests: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
  t.mock.method(TypeSafeClient.prototype, "systemOne", (async (request: (typeof requests)[number]) => {
    requests.push(request);
    const answers = Object.fromEntries(Object.keys(request.questions).map((q) => [q, sure("x")]));
    return { model: "test", answers: { ...answers, satisfied: { noul: 0.9 } } };
  }) as never);
  try {
    const jev = new JevDecider();
    const obs = parseSnapshot("- paragraph [ref=e1]: Status: Not Scheduled");
    assert.equal((await jev.assess('the status should be "Scheduled"', obs, false)).judged, undefined);
    assert.deepEqual(Object.keys(requests.at(-1)!.questions), ["kind", "negated", "subject", "state", "area"]);
    assert.equal((await jev.assess("the form looks complete", obs, true)).judged, 0.9);
    assert.ok("satisfied" in requests.at(-1)!.questions);
  } finally {
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
  }
});
