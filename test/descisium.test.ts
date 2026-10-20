import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Browser } from "../src/browser.ts";
import { gate, JevDecider, type Assessment, type Decider, type Pick } from "../src/jev.ts";
import { MASK, parseSnapshot, stepValues, type Observation } from "../src/observation.ts";
import { containsValue, runAssertion, runStep, type Runtime } from "../src/runner.ts";
import { parseFeature, parseStep } from "../src/feature.ts";

const APP = pathToFileURL("examples/campaign-app/index.html").href;

const NATIVE = `- generic [active] [ref=e1]:
  - generic [ref=e7]:
    - text: Activation period
    - combobox "Activation period" [ref=e8]:
      - option "1 week" [selected]
      - option "2 weeks"
  - textbox "Campaign name" [ref=e5]: Autumn Sale
  - button "Schedule" [disabled] [ref=e9]
  - paragraph [ref=e11]: "Status: Draft"`;

test("parseSnapshot keeps actionable refs, attaches native options, drops wrappers", () => {
  const obs = parseSnapshot(NATIVE);
  assert.deepEqual(obs.elements.map(e => [e.ref, e.verb]), [["e8", "SELECT"], ["e5", "TYPE"]]);
  assert.deepEqual(obs.elements[0].options, ["1 week", "2 weeks"]);
  assert.equal(obs.elements[0].value, "1 week");
  assert.deepEqual(obs.readable.map(e => e.ref), ["e8", "e5", "e9", "e11"]);
  assert.equal(obs.elements[1].value, "Autumn Sale");
  assert.ok(!obs.text.includes("generic [ref=e7]"));
  assert.ok(obs.text.includes("Status: Draft"));
});

test("parseSnapshot masks password values in elements and in the text sent to Jev", () => {
  const obs = parseSnapshot(`- textbox "Password" [ref=e3]: hunter2\n- textbox "User" [ref=e4]: ale`, new Set(["e3"]));
  assert.equal(obs.elements[0].value, MASK);
  assert.ok(obs.elements[0].secret);
  assert.equal(obs.elements[1].value, "ale");
  assert.ok(!obs.text.includes("hunter2") && obs.text.includes("ale"));
});

test("Browser: password fields are detected from the DOM; TYPE checks its effect", async () => {
  const b = await Browser.open(`data:text/html,<label>Password <input type=password value=hunter2></label><label>Code <input maxlength=3></label>`);
  try {
    const obs = await b.observe();
    assert.ok(!obs.text.includes("hunter2"));
    const code = obs.elements.find(e => e.name === "Code")!;
    await assert.rejects(b.execute({ verb: "TYPE", ref: code.ref, value: "12345" }), /does not hold the typed value/);
  } finally {
    await b.close();
  }
});

test("stepValues pulls quoted strings and numbers with units", () => {
  assert.deepEqual(stepValues(`Create a campaign called "Autumn Sale" for 2 weeks`), ["Autumn Sale", "2 weeks"]);
  assert.deepEqual(stepValues(`Set the campaign's name to "Autumn Sale"`), ["Autumn Sale"]);
});

test("containsValue matches whole words only", () => {
  assert.ok(containsValue("Status:  Scheduled", "scheduled"));
  assert.ok(!containsValue("11 weeks", "1 week"));
  assert.ok(!containsValue("Unscheduled", "Scheduled"));
});

test("gate needs a confident top answer with margin", () => {
  const p = (probabilities: Record<string, number>): Pick => ({ choice: "a", probabilities });
  assert.ok(gate(p({ a: 0.9, b: 0.1 })));
  assert.ok(!gate(p({ a: 0.7, b: 0.3 })));
  assert.ok(!gate(p({ a: 0.5, b: 0.45 })));
});

test("parseFeature: Then/And are assertions, try/attempt are attempts, Background and Outline rows expand", () => {
  const scenarios = parseFeature(`@url:http://feature
Feature: F
  Background:
    Given I am on the list
  Scenario: one
    When I open it
    And I try to schedule it
    Then the status is "Draft"
    And the button is disabled
    When I go back
  @url:http://scenario
  Scenario Outline: two <n>
    When I attempt <n>
    Examples:
      | n |
      | a |
      | b |
`);
  assert.deepEqual(scenarios.map(s => [s.name, s.url]), [["one", "http://feature"], ["two a", "http://scenario"], ["two b", "http://scenario"]]);
  assert.deepEqual(scenarios[0].steps.map(s => [s.text, s.kind]), [
    ["I am on the list", "action"], ["I open it", "action"], ["I try to schedule it", "attempt"],
    ["the status is \"Draft\"", "assertion"], ["the button is disabled", "assertion"], ["I go back", "action"],
  ]);
  assert.deepEqual(scenarios[2].steps.map(s => s.kind), ["action", "attempt"]);
  assert.deepEqual(parseStep(`Then the status should be "Draft"`), { text: `the status should be "Draft"`, kind: "assertion", line: 3 });
  assert.deepEqual(parseStep(`set the period to 2 weeks`), { text: "set the period to 2 weeks", kind: "action", line: 3 });
});

test("parseFeature rejects what it cannot run faithfully", () => {
  assert.throws(() => parseFeature(`Feature: f\n  Scenario: s\n    When I create:\n      | a |\n`), /data table or doc string/);
  // A keyword-less line is Gherkin "description": without the guard the scenario would pass with no steps.
  assert.throws(() => parseFeature(`Feature: f\n  Scenario: s\n    Attempt to schedule\n`), /has no steps/);
  assert.throws(() => parseFeature(`Feature: f\n  Scenario: s\n    When x\n  Scenario s2\n`), /Parser errors|expected/i);
});

// Scripted stand-in for Jev: exercises the browser runtime and loop without the API.
const sure = (choice: string): Pick => ({ choice, probabilities: { [choice]: 0.99, other: 0.01 } });
const seenRecent: string[][] = [];
const oracle: Decider = {
  async turn(_step, obs, recent) {
    seenRecent.push([...recent]);
    const box = obs.elements.find(e => e.role === "combobox")!;
    const selected = box.options.length ? /option "2 weeks" \[selected\]/.test(obs.text) : box.value === "2 weeks";
    const opt = obs.elements.find(e => e.role === "option" && e.name === "2 weeks");
    return { done: selected ? 1 : 0, target: sure((opt ?? box).ref) };
  },
  async value(_s, _o, _el, candidates) {
    assert.ok(candidates.includes("2 weeks"));
    return sure("2 weeks");
  },
  async assess() {
    throw new Error("not used");
  },
  async recall(_s, earlier) {
    return sure(Object.keys(earlier)[0] ?? "none");
  },
};

// Scripted assessment: answers what a correct model would.
const assessing = (kind: string, pick: (obs: Observation) => Partial<Assessment> = () => ({}), judged?: number): Decider => ({
  ...oracle,
  async assess(_step, obs, wantJudged) {
    const status = obs.readable.find(e => e.role === "paragraph")?.ref ?? "none";
    return { kind: sure(kind), subject: sure(status), area: sure("page"), state: sure("disabled"), judged: wantJudged ? judged : undefined, ...pick(obs) };
  },
});
const byName = (name: string) => (obs: Observation) => ({ subject: sure(obs.readable.find(e => e.name === name)?.ref ?? "none") });

test("runAssertion: value checks compare the subject's text", async () => {
  const b = await Browser.open(APP);
  try {
    const run = (s: string, d = assessing("value")) => runAssertion(s, b, d, () => {}).then(r => r.outcome);
    assert.equal(await run(`the status should be "draft"`), "PASSED");
    assert.equal(await run(`the status should be "Scheduled"`), "ASSERTION_FAILED");
    assert.equal(await run(`the status should be shown`), "UNVERIFIABLE");
    // A button's name is a label, not its value.
    assert.equal(await run(`the "Schedule" button should say "Schedule"`, assessing("value", byName("Schedule"))), "UNVERIFIABLE");
  } finally {
    await b.close();
  }
});

// Live check of the claim the design rests on: Jev picks the subject by meaning, not by matching text.
test("decoy: status assertion fails although another element says \"Scheduled\" (real Jev)", { skip: !process.env.TYPESAFE_API_KEY }, async () => {
  const b = await Browser.open(APP + "?decoy=1");
  try {
    const r = await runAssertion(`the campaign status should be "Scheduled"`, b, new JevDecider());
    assert.equal(r.outcome, "ASSERTION_FAILED");
  } finally {
    await b.close();
  }
});

test("runAssertion: presence, absence, state and judged checks", async () => {
  const b = await Browser.open(APP);
  try {
    const run = (s: string, d: Decider, judged = false) => runAssertion(s, b, d, () => {}, judged).then(r => r.outcome);
    assert.equal(await run(`the "Save draft" button is shown`, assessing("presence", byName("Save draft"))), "PASSED");
    assert.equal(await run(`the "Delete" button is shown`, assessing("presence")), "ASSERTION_FAILED"); // no text match: code decides
    assert.equal(await run(`the "Delete" button is not shown`, assessing("absence")), "PASSED");
    assert.equal(await run(`the "Schedule" button is disabled`, assessing("state", byName("Schedule"))), "ASSERTION_FAILED");
    assert.equal(await run(`the "Schedule" button is enabled`, assessing("state", obs => ({ ...byName("Schedule")(obs), state: sure("enabled") }))), "PASSED");
    assert.equal(await run(`the form looks complete`, assessing("fuzzy", undefined, 0.95)), "UNVERIFIABLE");
    assert.equal(await run(`the form looks complete`, assessing("fuzzy", undefined, 0.95), true), "JUDGED_PASSED");
    assert.equal(await run(`the form looks complete`, assessing("fuzzy", undefined, 0.5), true), "AMBIGUOUS");
    // Jev unsure between two kinds: fine when both reach the same result, AMBIGUOUS when they don't.
    const split = (probabilities: Record<string, number>) => assessing("value", () => ({ kind: { choice: "presence", probabilities } }));
    assert.equal(await run(`the status should show "Draft"`, split({ presence: 0.6, value: 0.4 })), "PASSED");
    assert.equal(await run(`the status should show "Draft"`, split({ absence: 0.6, value: 0.4 })), "AMBIGUOUS");
  } finally {
    await b.close();
  }
});

test("runAssertion: a state reading that cannot apply to the element drops out (native select)", async () => {
  const b = await Browser.open(APP); // native select, "1 week" selected
  try {
    const period = (obs: Observation) => obs.readable.find(e => e.role === "combobox")!.ref;
    // Live Jev splits "should be "<value>"" on a native select between value and "selected" (its options show [selected]).
    const split = (probabilities: Record<string, number>) =>
      assessing("value", obs => ({ kind: { choice: "value", probabilities }, subject: sure(period(obs)), state: sure("selected") }));
    const run = (d: Decider) => runAssertion(`the activation period should be "1 week"`, b, d, () => {}).then(r => r.outcome);
    assert.equal(await run(split({ value: 0.66, state: 0.34 })), "PASSED"); // was AMBIGUOUS: value->PASSED vs state->ASSERTION_FAILED
    assert.equal(await run(split({ state: 0.9, value: 0.1 })), "UNVERIFIABLE"); // only the inapplicable reading: no evidence
  } finally {
    await b.close();
  }
});

test("slow UI: WAIT returns on change, assertions retry until the UI shows the expected state", async () => {
  const b = await Browser.open(APP + "?slow=1");
  try {
    const name = (await b.observe()).elements.find(e => e.name === "Campaign name")!;
    await b.execute({ verb: "TYPE", ref: name.ref, value: "Autumn Sale" });
    await b.execute({ verb: "CLICK", ref: (await b.observe()).elements.find(e => e.name === "Schedule")!.ref });
    const t = Date.now();
    await b.execute({ verb: "WAIT" });
    assert.ok(Date.now() - t < 2500, `WAIT returned after the change, not the cap (${Date.now() - t} ms)`);
    assert.match((await b.observe()).text, /Status: Scheduled/);
  } finally {
    await b.close();
  }
  const c = await Browser.open(APP + "?slow=1");
  try {
    const name = (await c.observe()).elements.find(e => e.name === "Campaign name")!;
    await c.execute({ verb: "TYPE", ref: name.ref, value: "Autumn Sale" });
    await c.execute({ verb: "CLICK", ref: (await c.observe()).elements.find(e => e.name === "Schedule")!.ref });
    // Settle returned before the timer fired; a single read would see "Draft".
    assert.match((await c.observe()).text, /Status: Draft/);
    const r = await runAssertion(`the status should be "Scheduled"`, c, assessing("value"), () => {});
    assert.equal(r.outcome, "PASSED");
  } finally {
    await c.close();
  }
});

test("idle page: a failing check and WAIT give up at once instead of waiting the full cap", async () => {
  const b = await Browser.open(APP);
  try {
    let t = Date.now();
    const r = await runAssertion(`the status should be "Scheduled"`, b, assessing("value"), () => {});
    assert.equal(r.outcome, "ASSERTION_FAILED");
    assert.ok(Date.now() - t < 1500, `failing check took ${Date.now() - t} ms`);
    t = Date.now();
    assert.equal(await b.waitForChange((await b.observe()).text), false);
    assert.ok(Date.now() - t < 1500, `waitForChange on an idle page took ${Date.now() - t} ms`);
  } finally {
    await b.close();
  }
});

test("runStep refuses low-confidence targets and stops when actions change nothing", async () => {
  const b = await Browser.open(APP);
  const ref = async (name: string) => (await b.observe()).elements.find(e => e.name === name)!.ref;
  try {
    const unsure: Decider = { ...oracle, turn: async () => ({ done: 0, target: { choice: "x", probabilities: { x: 0.5, y: 0.45 } } }) };
    assert.equal((await runStep("anything", b, unsure, () => {})).outcome, "AMBIGUOUS");

    const draft = await ref("Save draft"); // clicking it changes nothing on the page
    const noop: Decider = { ...oracle, turn: async () => ({ done: 0, target: sure(draft) }) };
    assert.equal((await runStep("Save the draft", b, noop, () => {})).outcome, "BLOCKED");

    const scrolling: Decider = { ...oracle, turn: async () => ({ done: 0, target: sure("scroll") }) };
    assert.equal((await runStep("Load more", b, scrolling, () => {})).outcome, "BLOCKED"); // nothing more loads
  } finally {
    await b.close();
  }
});

for (const variant of ["", "?dropdown=custom"]) {
  test(`runStep sets activation period end-to-end ${variant || "(native)"}`, async () => {
    const b = await Browser.open(APP + variant);
    try {
      const r = await runStep("Set the activation period to 2 weeks", b, oracle, () => {});
      assert.equal(r.outcome, "DONE");
      const obs = await b.observe();
      assert.match(obs.text, variant ? /combobox "Activation period" \[ref=\w+\]: 2 weeks/ : /option "2 weeks" \[selected\]/);
      // The last turn saw what was already done in this Step.
      assert.deepEqual(seenRecent.at(-1), variant
        ? ['CLICK combobox "Activation period"', 'CLICK option "2 weeks"']
        : ['SELECT combobox "Activation period" <- "2 weeks"']);
    } finally {
      await b.close();
    }
  });
}

test("cassette replays identical requests, fails UI_CHANGED with the difference, discards on model change", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { Cassette, UiChanged } = await import("../src/cassette.ts");
  const path = `${mkdtempSync(`${tmpdir()}/cas-`)}/t.cassette.json`;
  const req = (ui: string) => ({ state: { step: "s", ui }, questions: {} });
  let calls = 0;
  const live = async () => ({ n: ++calls });

  const rec = new Cassette(path, "m1", "once");
  assert.deepEqual(await rec.call(req("a\nb"), live), { n: 1 });
  rec.save();

  const replay = new Cassette(path, "m1", "once"); // file exists: replay only
  assert.deepEqual(await replay.call(req("a\nb"), live), { n: 1 });
  assert.equal(calls, 1);
  await assert.rejects(replay.call(req("a\nc"), live), (e: Error) =>
    e instanceof UiChanged && e.diff === "  - b\n  + c");

  const drift = new Cassette(path, "m1", "new");
  assert.deepEqual(await drift.call(req("a\nc"), live), { n: 2 });
  assert.equal(drift.recorded, 1);

  const other = new Cassette(path, "m2", "none");
  await assert.rejects(other.call(req("a\nb"), live), UiChanged);
});

test("scoped presence: code looks for the quoted text inside the area Jev names", async () => {
  const obs = parseSnapshot([
    `- heading "Spring Sale" [level=1] [ref=e1]`,
    `- list "Scheduled campaigns" [ref=e2]:`,
    `  - listitem [ref=e3]: "2026-12-01: Winter Sale"`,
    `- status [ref=e4]: Campaign "Summer Sale" saved`,
  ].join("\n"));
  assert.deepEqual(obs.areas.map(e => e.ref), ["e2"]);
  const rt: Runtime = { observe: async () => obs, execute: async () => {}, waitForChange: async () => false };
  const run = (s: string, kind: string, area: string) =>
    runAssertion(s, rt, assessing(kind, () => ({ area: sure(area) })), () => {}).then(r => r.outcome);
  assert.equal(await run(`"Winter Sale" should appear in the calendar`, "presence", "e2"), "PASSED");
  assert.equal(await run(`"Summer Sale" should appear in the calendar`, "presence", "e2"), "ASSERTION_FAILED"); // only the toast mentions it
  assert.equal(await run(`the campaign list should contain "Spring Sale"`, "presence", "missing"), "ASSERTION_FAILED"); // heading, no list
  assert.equal(await run(`"Spring Sale" should not appear in the campaign list`, "absence", "missing"), "PASSED");
  assert.equal(await run(`"Summer Sale" is shown`, "presence", "page"), "PASSED");
  // Unsure which area: fine when the plausible areas agree, AMBIGUOUS when they don't.
  const split = (probabilities: Record<string, number>) => assessing("presence", () => ({ area: { choice: "", probabilities } }));
  const go = (s: string, d: Decider) => runAssertion(s, rt, d, () => {}).then(r => r.outcome);
  assert.equal(await go(`"Winter Sale" should appear in the calendar`, split({ e2: 0.6, page: 0.4 })), "PASSED");
  assert.equal(await go(`the campaign list should contain "Spring Sale"`, split({ missing: 0.6, page: 0.4 })), "AMBIGUOUS");
});

test("memory: a check that quotes nothing uses the value an earlier Step named", async () => {
  const obs = parseSnapshot(`- list "Scheduled campaigns" [ref=e2]:\n  - listitem [ref=e3]: "2026-12-01: Winter Sale"`);
  const rt: Runtime = { observe: async () => obs, execute: async () => {}, waitForChange: async () => false };
  const d = assessing("presence", () => ({ area: sure("e2") }));
  const run = (earlier: Record<string, string>) => runAssertion(`the campaign should appear in the calendar`, rt, d, () => {}, false, earlier).then(r => r.outcome);
  assert.equal(await run({}), "UNVERIFIABLE");
  assert.equal(await run({ "Winter Sale": `I enter "Winter Sale" as the campaign name` }), "PASSED");
  assert.equal(await run({ "Summer Sale": `I enter "Summer Sale" as the campaign name` }), "ASSERTION_FAILED");
});

test("run directory: trace.jsonl events, per-scenario folder, secret values masked", async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { RunDir } = await import("../src/trace.ts");
  const run = new RunDir(mkdtempSync(`${tmpdir()}/runs-`));
  const dir = run.scenario(0, "Log in!");
  assert.match(dir, /01-log-in$/);
  const obs = parseSnapshot(`- textbox "Password" [ref=e1]: hunter2`, new Set(["e1"]));
  await run.decider({ ...oracle, value: async () => sure("hunter2") }).value("s", obs, obs.readable[0], ["hunter2"]);
  run.failure(["boom"]);
  const lines = readFileSync(`${run.path}/trace.jsonl`, "utf8");
  assert.doesNotMatch(lines, /hunter2/);
  assert.deepEqual(lines.trim().split("\n").map(l => JSON.parse(l).type), ["scenario", "value"]);
  assert.ok(existsSync(`${dir}/console-errors.txt`));
});
