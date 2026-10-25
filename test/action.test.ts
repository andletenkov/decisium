import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilities, grouped, legacy, PAGE } from "../src/decision.ts";
import { parseSnapshot, withPage } from "../src/observation.ts";

const obs = withPage(parseSnapshot([
  '- textbox "Name" [active] [ref=e1]',
  '- listitem [draggable] [ref=e2]: Fix bug',
  '- list "Chat" [scrollable] [ref=e3]:\n  - listitem [ref=e4]: hi',
  '- link "Deutsch" [ref=e5]:\n  - /url: https://de.wikipedia.org/wiki/Ada',
  '- link "Deutsch" [ref=e6]:\n  - /url: https://de.wikipedia.org/wiki/Ada',
  '- link "Deutsch" [ref=e7]:\n  - /url: https://de.example.org/',
  '- button "Save" [ref=e8]',
  '- button "Save" [ref=e9]',
].join("\n")), "https://x/", "Notes");
const el = (ref: string) => obs.elements.find(e => e.ref === ref)!;

test("capabilities: each target offers only what it can do (task 0065)", () => {
  assert.deepEqual(capabilities(el("e1"), obs), ["type", "paste", "enter", "hover", "double click", "right click"]); // focused: Enter
  assert.ok(capabilities(el("e2"), obs).includes("drag") && !capabilities(el("e8"), obs).includes("drag"));
  assert.ok(capabilities(el("e3"), obs).includes("scroll up") && !capabilities(el("e8"), obs).includes("scroll up"));
  assert.deepEqual(capabilities(PAGE, obs, ["Escape", "Enter"]), ["scroll down", "scroll up", "wait", "back", "forward", "reload", "press Escape"]);
  assert.match(obs.text, /^- page "Notes" \[ref=page\]/);
});

test("grouped: links with the same name and URL count as one; other URLs and buttons do not (task 0065)", () => {
  const g = grouped({ choice: "e5", probabilities: { e5: 0.42, e6: 0.38, e7: 0.1, none: 0.1 } }, obs);
  assert.deepEqual(g, { choice: "e5", probabilities: { e5: 0.8, e7: 0.1, none: 0.1 } });
  // A selectable parent holding the link (Wikipedia's language option) is another target, not the link.
  const parent = withPage(parseSnapshot('- option "Deutsch" [ref=o1]:\n  - link "Deutsch" [ref=l1]:\n    - /url: https://de.wikipedia.org/wiki/Ada'), "https://x/", "T");
  assert.deepEqual(grouped({ choice: "l1", probabilities: { l1: 0.6, o1: 0.4 } }, parent).probabilities, { l1: 0.6, o1: 0.4 });
  const b = grouped({ choice: "e8", probabilities: { e8: 0.5, e9: 0.5 } }, obs);
  assert.deepEqual(b.probabilities, { e8: 0.5, e9: 0.5 });
});

test("legacy: older cassette answers read as page target + action, gestures as actions (task 0065)", () => {
  const page = legacy({ done: 0, target: { choice: "scroll", probabilities: { scroll: 0.6, "scroll up": 0.1, e1: 0.3 } } }, obs);
  assert.deepEqual(page.target.probabilities, { page: 0.7, e1: 0.3 });
  assert.equal(page.action!.choice, "scroll down");
  const enter = legacy({ done: 0, target: { choice: "enter", probabilities: { enter: 0.9, e8: 0.1 } } }, obs);
  assert.deepEqual([enter.target.choice, enter.action!.choice], ["e1", "enter"]); // Enter now belongs to the focused field
  const typed = legacy({ done: 0, target: { choice: "e1", probabilities: { e1: 1 } }, gesture: { choice: "default", probabilities: { default: 1 } } }, obs);
  assert.equal(typed.action!.choice, "type");
  assert.equal(legacy({ done: 0, target: { choice: "e8", probabilities: { e8: 1 } }, hover: 0.7 }, obs).action!.choice, "hover");
  assert.equal(legacy({ done: 0, target: { choice: "e8", probabilities: { e8: 1 } } }, obs, { upload: true }).action!.choice, "upload");
});
