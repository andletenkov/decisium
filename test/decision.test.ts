import assert from "node:assert/strict";
import { test } from "node:test";
import { traced, type Decider, type Pick } from "../src/decision.ts";
import { parseSnapshot, withDialog } from "../src/observation.ts";

const sure = (choice: string): Pick => ({ choice, probabilities: { [choice]: 0.99, other: 0.01 } });

test("traced: one event per question with the Step and the answer; a secret value masked, a dialog answer with its dialog", async () => {
  // A class with private state, like JevDecider: questions still run on the real object.
  class Scripted implements Decider {
    #asked = 0;
    async turn() { this.#asked++; return { done: 0.2, target: sure("e1") }; }
    async value() { return sure("hunter2"); }
    async assess() { return { kind: sure("value"), subject: sure("e1"), area: sure("page"), state: sure("disabled") }; }
    async recall() { return sure("Ada"); }
    async dialog() { return sure("accept"); }
    async drop() { return sure("e1"); }
    get asked() { return this.#asked; }
  }
  const events: [string, Record<string, unknown>][] = [];
  const live = new Scripted();
  const d = traced(live, (type, data) => events.push([type, data]));
  const obs = withDialog(parseSnapshot(`- textbox "Password" [ref=e1]`, new Set(["e1"])), { type: "confirm", message: "Sure?", state: "open" });
  const pw = obs.elements[0];
  await d.turn("I log in", obs, []);
  await d.value("I log in", obs, pw, ["hunter2"]);
  await d.dialog("I delete it", obs, ["accept", "dismiss"]);
  await d.recall("it should be shown", { Ada: "I add Ada" });
  assert.equal(live.asked, 1);
  assert.deepEqual(events, [
    ["turn", { step: "I log in", answer: { done: 0.2, target: sure("e1") } }],
    ["value", { step: "I log in", element: pw.line, answer: "(secret)" }],
    ["dialog", { step: "I delete it", dialog: { type: "confirm", message: "Sure?", state: "open" }, answer: sure("accept") }],
    ["recall", { step: "it should be shown", answer: sure("Ada") }],
  ]);
});
