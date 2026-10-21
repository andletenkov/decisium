import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Browser } from "../src/browser.ts";
import { gate, GATE_TARGET_MARGIN, GATE_TARGET_TOP, JevDecider, type Assessment, type Decider, type Pick } from "../src/jev.ts";
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

test("parseSnapshot: text with no element of its own is read from the container that holds it", () => {
  const obs = parseSnapshot(`- generic [ref=e1]:
  - generic [ref=e2]: Deposit Successful
  - generic [ref=e3]:
    - strong [ref=e4]: "2"
    - text: items left
  - generic [ref=e5]:
    - text: Your password is invalid!
  - generic [ref=e6]:
    - button "Save" [ref=e7]`);
  const line = (ref: string) => obs.readable.find(e => e.ref === ref)?.line;
  assert.equal(line("e3"), `generic value="2 items left"`); // split across a child and a bare text node
  assert.equal(line("e5"), `generic value="Your password is invalid!"`); // bare text node
  assert.equal(line("e2"), `generic value="Deposit Successful"`); // text on the container's own line, as before
  assert.equal(line("e6"), undefined); // holds a control, no text of its own
  // A container Jev can pick must be visible in the snapshot it reads; the others stay dropped.
  assert.ok(obs.text.includes("[ref=e3]") && obs.text.includes("[ref=e5]"));
  assert.ok(!obs.text.includes("[ref=e6]") && obs.text.includes(`button "Save"`));
});

test("parseSnapshot: a bare text that only labels a control inside the container is not readable text", () => {
  const obs = parseSnapshot(NATIVE);
  assert.equal(obs.readable.find(e => e.ref === "e7"), undefined); // "Activation period" is the combobox's label
  assert.ok(!obs.text.includes("generic [ref=e7]"));
});

test("Browser: editable comboboxes (search with suggestions) are typed into; button-like ones are clicked", async () => {
  const b = await Browser.open(`data:text/html,<input role=combobox aria-label="Search or jump to" aria-expanded=false>`
    + `<div role=combobox aria-label="Activation period" tabindex=0>1 week</div>`);
  try {
    const verbs = Object.fromEntries((await b.observe()).elements.map(e => [e.name, e.verb]));
    assert.deepEqual(verbs, { "Search or jump to": "TYPE", "Activation period": "CLICK" });
  } finally {
    await b.close();
  }
});

test("element descriptions shorten long values; checks still compare the full value", () => {
  const long = `name playwright-internal ${"version 1 ".repeat(500)}`.trim();
  const [el] = parseSnapshot(`- textbox "file content" [ref=e1]: ${long}`).readable;
  assert.ok(el.line.length < 120, el.line);
  assert.match(el.line, /^textbox "file content" value="name playwright-internal .*…"$/);
  assert.equal(el.value, long);
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
  // Which element to act on is gated lower than a check (task 0002), but a coin flip is still refused.
  assert.ok(gate(p({ a: 0.64, b: 0.22 }), GATE_TARGET_TOP, GATE_TARGET_MARGIN));
  assert.ok(!gate(p({ a: 0.47, b: 0.46 }), GATE_TARGET_TOP, GATE_TARGET_MARGIN));
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
  assert.deepEqual(parseStep(`Then the status should be "Draft"`), { text: `the status should be "Draft"`, kind: "assertion" });
  assert.deepEqual(parseStep(`set the period to 2 weeks`), { text: "set the period to 2 weeks", kind: "action" });
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
    // Absence fails on any one of the quoted texts; "all of them" would pass here although "Save draft" is shown.
    assert.equal(await run(`"Save draft" and "Delete" are not shown`, assessing("absence")), "ASSERTION_FAILED");
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

test("lazy UI: actions settle only after work due soon (idle callbacks, short timers) has run", async () => {
  const b = await Browser.open(APP + "?lazy=1");
  try {
    const name = (await b.observe()).elements.find(e => e.name === "Campaign name")!;
    await b.execute({ verb: "TYPE", ref: name.ref, value: "Autumn Sale" });
    await b.execute({ verb: "CLICK", ref: (await b.observe()).elements.find(e => e.name === "Schedule")!.ref });
    assert.match((await b.observe()).text, /Status: Scheduled/); // a single read right after the action
  } finally {
    await b.close();
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

    // Above the action gate but below the check gate: Jev's element is used (it is gone, so the Step says so).
    const lowish: Decider = { ...oracle, turn: async () => ({ done: 0, target: { choice: "gone", probabilities: { gone: 0.64, y: 0.22 } } }) };
    assert.equal((await runStep("anything", b, lowish, () => {})).outcome, "ELEMENT_NOT_FOUND");

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
  await assert.rejects(replay.call(req("a\nc"), live), (e: Error) => e instanceof UiChanged && e.reason ===
    "the page is not the one this step was recorded on, so the recorded Jev answer cannot be reused. Differences (- recorded, + now):\n  - b\n  + c");
  await assert.rejects(replay.call({ state: { step: "reworded", ui: "a\nb" }, questions: {} }, live), (e: Error) => e instanceof UiChanged && e.reason ===
    "this step has no recorded Jev answer: it is new or was reworded after the cassette was recorded, and replay-only mode does not call Jev");

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

test("Qase status: every outcome message starts with its outcome and the reporter classifies it as decided", async () => {
  const { determineTestStatus } = await import("qase-javascript-commons");
  const { HINTS, outcomeMessage, parseOutcome } = await import("../src/report.ts");
  // Reasons as the runner writes them, including words the reporter treats as assertion or infrastructure hints.
  const reasons = [
    "",
    `expected "Scheduled", but paragraph shows "Draft"`,
    `as a value check it is ASSERTION_FAILED (expected "x"); as a presence check it is PASSED`,
    "a value check needs exactly one quoted expected value; actual element not found",
    "  - button \"Expected to be called\"\n  + network timeout",
  ];
  const expected = {
    ASSERTION_FAILED: "failed", JUDGED_FAILED: "failed", BLOCKED: "failed", ACTION_FAILED: "failed",
    AMBIGUOUS: "invalid", UNVERIFIABLE: "invalid", UI_CHANGED: "invalid", ELEMENT_NOT_FOUND: "invalid", STEP_TIMEOUT: "invalid",
  };
  for (const [outcome, status] of Object.entries(expected)) {
    for (const reason of reasons) {
      const msg = outcomeMessage({ outcome, reason });
      assert.ok(msg.startsWith(outcome), msg);
      const err = new Error(msg);
      err.stack = msg; // what the step throws: no frames for the reporter to read keywords from
      assert.equal(determineTestStatus(err, "failed"), status, `${outcome}: ${reason}`);
      assert.deepEqual(parseOutcome(msg), { outcome, reason }); // the console shows the reason as written
      if (HINTS[outcome]) assert.ok(msg.replaceAll("\u2060", "").endsWith(`\nWhat to do: ${HINTS[outcome]}`), msg); // Qase readers get the hint too
    }
  }
  assert.equal(parseOutcome("Cannot open http://x: refused"), undefined);
});

test("Qase preflight (testops mode): missing token or unknown case id is one line before anything runs", async () => {
  const { createServer } = await import("node:http");
  const { qasePreflight, qaseIds } = await import("../src/qase.ts");
  assert.deepEqual(qaseIds(["@url:x", "@QaseID=3,4", "@Q-7", "@qaseid=8"]), [3, 4, 7, 8]);
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.token}`);
    res.statusCode = req.headers.token !== "good" ? 401 : req.url === "/v1/case/DEMO/1" ? 200 : 404;
    res.end("{}");
  });
  await new Promise<void>(r => server.listen(0, r));
  const host = `http://localhost:${(server.address() as { port: number }).port}`;
  const env = (token?: string) => ({ QASE_MODE: "testops", QASE_TESTOPS_PROJECT: "DEMO", QASE_TESTOPS_API_HOST: host, QASE_TESTOPS_API_TOKEN: token });
  const scenarios = [{ name: "a", tags: ["@QaseID=1"] }, { name: "b", tags: ["@QaseID=99"] }, { name: "c", tags: [] }];
  try {
    assert.equal(await qasePreflight(scenarios, {}), undefined); // reporter off: nothing to check
    assert.match((await qasePreflight(scenarios, env()))!, /^QASE_TESTOPS_API_TOKEN is not set/);
    assert.match((await qasePreflight(scenarios, env("bad")))!, /^Qase rejected QASE_TESTOPS_API_TOKEN/);
    assert.equal(await qasePreflight(scenarios, env("good")), `Qase case DEMO-99 not found (scenario "b", @QaseID=99).`);
    assert.equal(await qasePreflight(scenarios.slice(0, 1), env("good")), undefined);
    assert.ok(seen.includes("/v1/case/DEMO/1 good"));
  } finally {
    server.close();
  }
});

test("narrow: more candidates than Jev accepts are cut down in rounds, keeping the right one and the fixed answers", async () => {
  const { narrow } = await import("../src/jev.ts");
  const candidates = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`e${i}`, `link "item ${i}"`]));
  const fixed = { none: "nothing", scroll: "scroll down" };
  const sizes: number[] = [];
  // Fake Jev: likes e450 most, then e3; everything else shares the rest.
  const ask = async (criteria: Record<string, string>) => {
    sizes.push(Object.keys(criteria).length);
    const keys = Object.keys(criteria);
    const w = (k: string) => (k === "e450" ? 50 : k === "e3" ? 10 : 1);
    const total = keys.reduce((s, k) => s + w(k), 0);
    return { choice: "", probabilities: Object.fromEntries(keys.map(k => [k, w(k) / total])) };
  };
  const out = await narrow(candidates, fixed, ask, 255);
  assert.ok(sizes.every(n => n <= 255), `asked with ${sizes}`);
  assert.ok(Object.keys(out).length <= 255);
  assert.ok("e450" in out && "e3" in out && "none" in out && "scroll" in out);
  assert.equal(out.e450, `link "item 450"`);
  // Small enough already: no extra questions.
  sizes.length = 0;
  assert.deepEqual(await narrow({ e1: "a" }, fixed, ask, 255), { e1: "a", ...fixed });
  assert.equal(sizes.length, 0);
});

test("oversized page: ui drops /url lines and caps lines; reduceUi keeps the step's section under budget", async () => {
  const { reduceUi, UI_BUDGET } = await import("../src/jev.ts");
  const obs = parseSnapshot(`- link "Docs" [ref=e1]:\n  - /url: /docs\n- paragraph [ref=e2]: ${"cite ".repeat(100)}`);
  assert.doesNotMatch(obs.text, /\/url/);
  assert.ok(obs.text.split("\n").every(l => l.length <= 201), obs.text);
  assert.equal(obs.readable[1].value.length, 500); // checks still read the full text

  // A 300k-char page; the step's element sits deep in one list.
  const rows = Array.from({ length: 3000 }, (_, i) => `    - listitem [ref=e${i}]: ${i === 2200 ? "Latest release v9" : "row " + "x".repeat(80)}`);
  const ui = ["- main [ref=m]:", "  - list \"Releases\" [ref=l]:", ...rows].join("\n");
  const asked: number[] = [];
  const ask = async (sections: Record<string, string>) => {
    asked.push(Object.values(sections).join("").length);
    const keys = Object.keys(sections);
    const w = (k: string) => (sections[k].includes("Latest release") ? 50 : 1);
    const total = keys.reduce((s, k) => s + w(k), 0);
    return { choice: "", probabilities: Object.fromEntries(keys.map(k => [k, w(k) / total])) };
  };
  const out = await reduceUi(ui, ask);
  assert.ok(out.length <= UI_BUDGET, `${out.length}`);
  assert.ok(asked.every(n => n <= UI_BUDGET), `asked with ${asked}`);
  assert.match(out, /Latest release v9/);
  assert.match(out, /^- main \[ref=m\]:\n  - list "Releases"/); // ancestors kept, in page order
  assert.equal(await reduceUi("small", ask), "small");
});

test("Enter: offered only while a text field has focus; submits what was typed", async () => {
  const { pageActions } = await import("../src/jev.ts");
  const page = `data:text/html,<form onsubmit="event.preventDefault();o.textContent='Results for '+q.value">`
    + `<input id=q aria-label="Search"></form><p id=o></p>`;
  const b = await Browser.open(page);
  try {
    assert.ok(!("enter" in pageActions(await b.observe())), "no field has focus yet");
    // Scripted Jev: type into the search box, press Enter, then done once results show.
    const decider: Decider = {
      ...oracle,
      async turn(_s, obs) {
        if (/Results for/.test(obs.text)) return { done: 1, target: sure("none") };
        const box = obs.elements.find(e => e.name === "Search")!;
        if (!box.value) return { done: 0, target: sure(box.ref) };
        assert.ok("enter" in pageActions(obs), "field focused after typing");
        return { done: 0, target: sure("enter") };
      },
      async value() { return sure("playwright"); },
    };
    const r = await runStep(`search for "playwright"`, b, decider, () => {});
    assert.equal(r.outcome, "DONE");
    assert.match((await b.observe()).text, /Results for playwright/);
  } finally {
    await b.close();
  }
});

test("current link: aria-current marks the link [current]; a 'selected' check on a link reads it", async () => {
  // "Open" and "Closed" share href="#" (as on GitHub's issue list); only "Open" is current.
  const b = await Browser.open(`data:text/html,<nav aria-label=Repository><a href="/code">Code</a><a href="/issues" aria-current=page>Issues</a></nav>`
    + `<a href="%23" aria-current=true>Open</a><a href="%23">Closed</a>`);
  try {
    const obs = await b.observe();
    const line = (name: string) => obs.readable.find(e => e.name === name)!.line;
    assert.match(line("Issues"), /\[current\]/);
    assert.doesNotMatch(line("Code"), /\[current\]/);
    assert.match(line("Open"), /\[current\]/);
    assert.doesNotMatch(line("Closed"), /\[current\]/);
    const check = async (name: string, state: string) => (await runAssertion(`the "${name}" tab should be ${state}`, b,
      assessing("state", o => ({ subject: sure(o.readable.find(e => e.name === name)!.ref), state: sure(state) })), () => {})).outcome;
    assert.equal(await check("Issues", "selected"), "PASSED");
    assert.equal(await check("Code", "selected"), "ASSERTION_FAILED");
    assert.equal(await check("Code", "unselected"), "PASSED");
  } finally {
    await b.close();
  }
});

test("subject: when Jev is unsure which element a check is about, every plausible one is checked and they must agree", async () => {
  const obs = parseSnapshot([
    `- navigation "Breadcrumbs" [ref=e1]:`,
    `  - link "playwright" [ref=e2]`,
    `- heading "playwright" [level=1] [ref=e3]`,
    `- paragraph [ref=e4]: "Status: Draft"`,
    `- button "Save" [disabled] [ref=e5]`,
    `- button "Delete" [ref=e6]`,
  ].join("\n"));
  const rt: Runtime = { observe: async () => obs, execute: async () => {}, waitForChange: async () => false };
  const split = (kind: string, probabilities: Record<string, number>, state = "disabled") =>
    runAssertion(kind === "value" ? `the repository name should be "playwright"` : `the button should be ${state}`, rt,
      assessing(kind, () => ({ subject: { choice: "", probabilities }, state: sure(state) })), () => {}).then(r => r.outcome);
  // Breadcrumb link and title heading both show the name (a link's text is what it shows, like a heading's).
  assert.equal(await split("value", { e2: 0.55, e3: 0.4, e4: 0.05 }), "PASSED");
  assert.equal(await split("value", { e2: 0.99 }), "PASSED");
  assert.equal(await split("value", { e3: 0.5, e4: 0.45 }), "AMBIGUOUS"); // the heading shows it, the status does not
  assert.equal(await split("value", { e3: 0.5, none: 0.45 }), "AMBIGUOUS"); // "nothing matches" is a reading too
  // A button's text is its label, not a value it shows: no evidence, so the other reading decides.
  assert.equal(await split("value", { e6: 0.55, e4: 0.4 }), "ASSERTION_FAILED");
  assert.equal(await split("value", { e6: 0.99 }), "UNVERIFIABLE");
  assert.equal(await split("state", { e5: 0.6, e6: 0.35 }), "AMBIGUOUS");
  assert.equal(await split("state", { e5: 0.6, e6: 0.35 }, "enabled"), "AMBIGUOUS");
  assert.equal(await split("state", { e5: 0.99, e6: 0.01 }), "PASSED");
});

test("run directory: runs started in the same millisecond get their own directory", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { RunDir } = await import("../src/trace.ts");
  const root = mkdtempSync(`${tmpdir()}/runs-`);
  const paths = Array.from({ length: 5 }, () => new RunDir(root).path);
  assert.equal(new Set(paths).size, 5, paths.join(", "));
});
