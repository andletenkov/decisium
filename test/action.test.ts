import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilities, grouped, PAGE } from "../src/decision.ts";
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

