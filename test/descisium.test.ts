import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Browser } from "../src/browser.ts";
import { gate, JevDecider, type Assessment, type Decider, type Pick } from "../src/jev.ts";
import { MASK, parseSnapshot, stepValues, type Observation } from "../src/observation.ts";
import { containsValue, runAssertion, runStep } from "../src/runner.ts";
import { parseTestFile } from "../src/testfile.ts";

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

test("parseTestFile classifies Then/And as assertions", () => {
  const f = parseTestFile(`Test: T\nURL: http://x\n# c\nWhen I do a\nAnd b\nThen c is "X"\nAnd d`);
  assert.equal(f.url, "http://x");
  assert.deepEqual(f.steps.map(s => [s.text, s.assertion]), [["I do a", false], ["b", false], ["c is \"X\"", true], ["d", true]]);
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
};

// Scripted assessment: answers what a correct model would.
const assessing = (kind: string, pick: (obs: Observation) => Partial<Assessment> = () => ({}), judged?: number): Decider => ({
  ...oracle,
  async assess(_step, obs, wantJudged, mentioned) {
    const status = obs.readable.find(e => e.role === "paragraph")!.ref;
    const holder = sure(mentioned[0]?.ref ?? "none");
    return { kind: sure(kind), subject: sure(status), holder, state: sure("disabled"), judged: wantJudged ? judged : undefined, ...pick(obs) };
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
