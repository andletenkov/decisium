import assert from "node:assert/strict";
import { test } from "node:test";
import { traced, type Decider, type Pick } from "../src/decision.ts";
import { parseSnapshot, withDialog } from "../src/observation.ts";

const sure = (choice: string): Pick => ({ choice, probabilities: { [choice]: 0.99, other: 0.01 } });

test("traced: one event per question with the Step and the answer; a secret value masked, a dialog answer with its dialog", async () => {
  // A class with private state, like JevDecider: questions still run on the real object.
  class Scripted implements Decider {
    #asked = 0;
    async turn() {
      this.#asked++;
      return { done: 0.2, target: sure("e1") };
    }
    async value() {
      return sure("hunter2");
    }
    async assess() {
      return {
        kind: sure("value"),
        negated: sure("no"),
        subject: sure("e1"),
        area: sure("page"),
        state: sure("disabled"),
      };
    }
    async recall() {
      return sure("Ada");
    }
    async dialog() {
      return sure("accept");
    }
    async drop() {
      return sure("e1");
    }
    get asked() {
      return this.#asked;
    }
  }
  const events: [string, Record<string, unknown>][] = [];
  const live = new Scripted();
  const d = traced(live, (type, data) => events.push([type, data]));
  const obs = withDialog(parseSnapshot(`- textbox "Password" [ref=e1]`, new Set(["e1"])), {
    type: "confirm",
    message: "Sure?",
    state: "open",
  });
  const pw = obs.elements[0];
  await d.turn("I log in", obs, []);
  await d.value("I log in", obs, pw, ["hunter2"]);
  await d.dialog("I delete it", obs, ["accept", "dismiss"]);
  await d.recall("it should be shown", { Ada: "I add Ada" });
  assert.equal(live.asked, 1);
  assert.deepEqual(events, [
    ["turn", { step: "I log in", answer: { done: 0.2, target: sure("e1") } }],
    ["value", { step: "I log in", element: pw.line, answer: "(secret)" }],
    [
      "dialog",
      { step: "I delete it", dialog: { type: "confirm", message: "Sure?", state: "open" }, answer: sure("accept") },
    ],
    ["recall", { step: "it should be shown", answer: sure("Ada") }],
  ]);
});

import {
  ACTIONS,
  AREA_MISSING,
  AREA_PAGE,
  capabilities,
  confidence,
  describeAction,
  fmt,
  gate,
  grouped,
  named,
  NotYet,
  PAGE,
  plausible,
} from "../src/decision.ts";
import { DEFAULTS } from "../src/options.ts";

test("capabilities: the page's, with tabs and the Step's keys; an element's by verb, state and gestures", () => {
  const plain = parseSnapshot("");
  assert.deepEqual(capabilities(PAGE, plain), ["scroll down", "scroll up", "wait", "back", "forward", "reload"]);
  const tabs = { ...plain, readable: [{ ref: "tabs" } as never] };
  assert.deepEqual(capabilities(PAGE, tabs, ["Enter", "Escape"]), [
    "scroll down",
    "scroll up",
    "wait",
    "back",
    "forward",
    "reload",
    "close tab",
    "switch tab",
    "press Escape",
  ]);
  const obs = parseSnapshot(
    [
      `- textbox "A" [active] [ref=e1]`,
      `- textbox "B" [ref=e2]`,
      `- combobox "C" [ref=e3]:`,
      `  - option "x"`,
      `- img "D" [draggable] [ref=e4]`,
      `- region "E" [scrollable] [ref=e5]`,
    ].join("\n"),
  );
  const [a, b, c, d, e] = obs.elements;
  const gestures = ["hover", "double click", "right click"];
  assert.deepEqual(capabilities(a, obs), ["type", "paste", "enter", ...gestures]);
  assert.deepEqual(capabilities(b, obs), ["type", "paste", ...gestures]);
  assert.deepEqual(capabilities(c, obs), ["select", ...gestures]);
  assert.deepEqual(capabilities(d, obs), ["click", "upload", ...gestures, "drag"]);
  assert.deepEqual(capabilities(e, obs), ["click", "upload", ...gestures, "scroll down", "scroll up"]);
});

test("describeAction: ACTIONS text, or the key a press names", () => {
  assert.equal(describeAction("click"), ACTIONS.click);
  assert.equal(describeAction("press Escape"), "Press the Escape key, as `step` says.");
});

test("grouped: same-name same-URL links sum into the first; buttons and other links stay apart", () => {
  const obs = parseSnapshot(
    [
      `- link "De" [ref=e1]:`,
      `  - /url: /de`,
      `- link "De" [ref=e2]:`,
      `  - /url: /de`,
      `- link "De" [ref=e3]:`,
      `  - /url: /other`,
      `- button "Go" [ref=e4]`,
      `- button "Go" [ref=e5]`,
      `- link "Nowhere" [ref=e6]`,
      `- link "Nowhere" [ref=e7]`,
    ].join("\n"),
  );
  const p = { choice: "e3", probabilities: { e1: 0.2, e3: 0.3, e2: 0.25, e4: 0.1, e5: 0.1, e6: 0.03, e7: 0.02 } };
  const g = grouped(p, obs);
  assert.equal(g.choice, "e1");
  assert.deepEqual(g.probabilities, { e1: 0.45, e3: 0.3, e4: 0.1, e5: 0.1, e6: 0.03, e7: 0.02 });
  assert.equal(grouped({ choice: "x", probabilities: {} }, obs).choice, "x");
  assert.equal(grouped({ choice: "none", probabilities: { none: 1 } }, obs).choice, "none");
});

test("named and fmt: top three, highest first, elements by their line, special answers in words", () => {
  const obs = parseSnapshot(`- button "Go" [ref=e1]\n- list "L" [ref=e2]:\n  - listitem "i" [ref=e3]`);
  const p = { choice: "e1", probabilities: { none: 0.05, e1: 0.5, [AREA_PAGE]: 0.2, [AREA_MISSING]: 0.15, x: 0.1 } };
  assert.equal(named(p, obs), `button "Go" 50%, anywhere on the page 20%, an area not on this screen 15%`);
  assert.equal(named({ choice: "e2", probabilities: { e2: 0.6, e3: 0.4 } }, obs), `list "L" 60%, listitem "i" 40%`);
  assert.equal(named({ choice: "none", probabilities: { none: 0.9, e1: 0.1 } }), "nothing 90%, e1 10%");
  assert.equal(fmt(p), "e1=0.50 page=0.20 missing=0.15");
});

test("gate: top at least minTop and ahead of the second by minMargin; defaults from the pick's confidence", () => {
  const p = (probabilities: Record<string, number>, recordedConfidence?: typeof DEFAULTS.confidence) => ({
    choice: "a",
    probabilities,
    recordedConfidence,
  });
  assert.equal(gate(p({ a: 0.8, b: 0.5 })), true);
  assert.equal(gate(p({ a: 0.8, b: 0.51 })), false);
  assert.equal(gate(p({ a: 0.79 })), false);
  assert.equal(gate(p({ b: 0.1, a: 0.8 })), true);
  assert.equal(gate(p({})), false);
  assert.equal(gate(p({ a: 0.6 }, { target: 0.5, answer: 0.6 })), true);
  assert.equal(gate(p({ a: 0.5, b: 0.4 }), 0.5, 0.1), true); // 0.5 - 0.4 is 0.0999… in floats
  assert.equal(gate(p({ a: 0.5, b: 0.41 }), 0.5, 0.1), false);
  assert.deepEqual(confidence(p({})), DEFAULTS.confidence);
});

test("plausible: most likely first until they cover the gate's confidence", () => {
  const p = { choice: "a", probabilities: { c: 0.1, a: 0.5, b: 0.3, d: 0.1 } };
  assert.deepEqual(plausible(p), ["a", "b"]);
  assert.deepEqual(plausible(p, 0.85), ["a", "b", "c"]);
  assert.deepEqual(plausible(p, 0.5), ["a"]);
  assert.deepEqual(plausible(p, 0.8), ["a", "b"]);
  assert.deepEqual(plausible({ ...p, recordedConfidence: { target: 0.5, answer: 0.5 } }), ["a"]);
  assert.deepEqual(plausible(p, 0), []);
});

test("NotYet carries the final error and its message", () => {
  const final = new Error("later");
  const e = new NotYet(final);
  assert.equal(e.final, final);
  assert.equal(e.message, "later");
});

test("traced: non-function properties pass through; other questions trace step and answer", async () => {
  const d = { tag: 7, assess: async () => "A" } as unknown as Decider;
  const events: unknown[] = [];
  const t = traced(d, (type, data) => events.push([type, data]));
  assert.equal((t as unknown as { tag: number }).tag, 7);
  assert.equal(await t.assess("s", parseSnapshot(""), false), "A");
  const pw = parseSnapshot(`- textbox "N" [ref=e1]`).elements[0];
  await traced({ value: async () => sure("v") } as unknown as Decider, (type, data) => events.push([type, data])).value(
    "s",
    parseSnapshot(""),
    pw,
    [],
  );
  assert.deepEqual(events, [
    ["assess", { step: "s", answer: "A" }],
    ["value", { step: "s", element: `textbox "N"`, answer: sure("v") }],
  ]);
});
