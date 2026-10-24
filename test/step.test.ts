import assert from "node:assert/strict";
import { test } from "node:test";
import { readStep, type ParsedStep } from "../src/step.ts";

const action = (text: string, more: Partial<ParsedStep> = {}) => readStep({ text, kind: "action", ...more });
const check = (text: string, more: Partial<ParsedStep> = {}) => readStep({ text, kind: "assertion", ...more });

test("readStep: Candidate values are quoted strings and numbers with units, plus the doc string", () => {
  assert.deepEqual(action(`Create a campaign called "Autumn Sale" for 2 weeks`).candidates, ["Autumn Sale", "2 weeks"]);
  assert.deepEqual(action(`Set the campaign's name to "Autumn Sale"`).candidates, ["Autumn Sale"]); // an apostrophe opens no quote
  assert.deepEqual(action("I write the notes:", { docString: "Hello" }).candidates, ["Hello"]);
  assert.deepEqual(action(`I set "Name" to 3`).quoted, ["Name"]);
});

test("readStep: what a check compares, and how its table reads", () => {
  assert.deepEqual(check(`the status should be "Draft"`).values, ["Draft"]);
  assert.deepEqual(check("the notes should say:", { docString: "Hi" }).values, ["Hi"]);
  const list = check("the cart should show:", { table: [["Backpack"], ["Bike Light"]] });
  assert.deepEqual([list.values, list.list, list.header], [["Backpack", "Bike Light"], true, false]);
  const rows = check("the cart should list:", { table: [["Product", "Qty"], ["Backpack", "2"]] });
  assert.deepEqual([rows.values, rows.list, rows.header], [[], false, true]);
  assert.deepEqual([check("the cart should show exactly:").exact, check("the rows in this order").exact, check("the cart").exact], [true, true, false]);
});

test("readStep: labels for reports and cassette keys, and an action's table as one Step per row", () => {
  assert.equal(action("I fill in the form:", { table: [["First name", "Ada"], ["Last name", "Lovelace"]] }).label, "I fill in the form: [First name=Ada, Last name=Lovelace]");
  assert.equal(action("I write the notes:", { docString: `Line one.\nLine "two".` }).label, `I write the notes: "Line one.\\nLine \\"two\\"."`);
  assert.equal(check("the cart should list:", { table: [["Product", "Qty"], ["Backpack", "2"]] }).label, "the cart should list: [Product=Backpack, Qty=2]");
  assert.equal(action("I add these:", { table: [["Backpack"], ["Bike Light"]] }).label, "I add these: [Backpack, Bike Light]");
  assert.equal(action("I go back").label, "I go back");
  assert.deepEqual(action("I fill in the form:", { table: [["First name", "Ada"], ["Last name", "Lovelace"]] }).rows,
    [`I enter "Ada" as First name`, `I enter "Lovelace" as Last name`]);
  assert.deepEqual(action("I add these products to the cart:", { table: [["Backpack"], ["Bike Light"]] }).rows,
    [`I add these products to the cart "Backpack"`, `I add these products to the cart "Bike Light"`]);
  assert.deepEqual(action("I order:", { table: [["Product", "Quantity", "Gift"], ["Backpack", "2", "no"]] }).rows, [`I order Product "Backpack", Quantity "2", Gift "no"`]);
  assert.deepEqual(action("I order:", { table: [["Product", "Quantity", "Gift"]] }).rows, []); // a header alone
  assert.deepEqual(check("the cart should show:", { table: [["Backpack"]] }).rows, ["the cart should show:"]); // a check runs once
  assert.deepEqual(action("I go back").rows, ["I go back"]);
});

test("readStep: Secret placeholders, quoted, as the doc string or as a table cell", () => {
  assert.deepEqual(action(`I log in as "$USER"`, { docString: "$NOTE" }).placeholders, ["$USER", "$NOTE"]);
  assert.deepEqual(action("I fill in the form:", { table: [["Password", "$PW"], ["Name", "Ada"]] }).placeholders, ["$PW"]);
});

test("readStep: a check or uncheck Step that does nothing else names the box state it wants", () => {
  assert.deepEqual([`I check "A"`, "I uncheck checkbox 2", `I check "A" and submit`, "I open the page"].map(s => action(s).toggle), [true, false, undefined, true]);
  assert.deepEqual(["I accept the terms", "I disable dark mode", "I opt out of tracking", "I unsubscribe"].map(s => action(s).toggle), [true, false, false, false]);
});

test("readStep: Named keys after press/hit, as Playwright names them (task 0039)", () => {
  const keys = (s: string) => action(s).keys;
  const none = (s: string) => assert.deepEqual([action(s).keys, action(s).unknownKeys], [[], []], s);
  assert.deepEqual(keys("I press Escape"), ["Escape"]);
  assert.deepEqual(keys(`I press "Escape"`), ["Escape"]);
  assert.deepEqual(keys("I hit the Esc key"), ["Escape"]);
  assert.deepEqual(keys("I press Ctrl+K and hit Shift + Tab"), ["Control+K", "Shift+Tab"]);
  assert.deepEqual(keys("I press Cmd+K"), ["Meta+K"]); // as written: no Mod mapping
  assert.deepEqual(keys("I press the down arrow twice"), ["ArrowDown"]);
  assert.deepEqual(keys("I hit PageDown, then F2, then Return, Space, Backspace and Delete"), ["PageDown"]); // one key per press/hit
  assert.deepEqual(["F2", "Return", "Space", "Backspace", "Delete", "Home", "page up", "arrow left", "Tab"].map(k => keys(`press ${k}`)[0]),
    ["F2", "Enter", "Space", "Backspace", "Delete", "Home", "PageUp", "ArrowLeft", "Tab"]);
  // Not keys: clicking a button by its name, words that are not after press/hit.
  for (const s of [`I press the "Save" button`, "I press Save", "I delete the campaign", "I open the Settings tab"]) none(s);
  // A key the Step means but that is not a key name.
  assert.deepEqual(action("I press the Foo key").unknownKeys, ["Foo"]);
  assert.deepEqual(action("I press Ctrl+Kay").unknownKeys, ["Ctrl+Kay"]);
  // A Step that is only "press X": code presses it.
  assert.deepEqual(["I press Escape", `press "Tab"`, "I hit the down arrow.", "I press Ctrl+K", "I press Escape to close the dialog", "I press the Save button"].map(s => action(s).pressOnly),
    ["Escape", "Tab", "ArrowDown", "Control+K", undefined, undefined]);
  // A button or link named like a key is clicked, not pressed; quoted text to type names no key.
  for (const s of ["I press the Delete button", "I hit the Home link", `I type "press Escape to quit" in the note`, `I write the notes: "hit Tab"`]) none(s);
  assert.deepEqual(keys(`I type "Ada" and press "Tab"`), ["Tab"]);
  assert.deepEqual(keys("I press the Delete key"), ["Delete"]);
  assert.deepEqual(action("I write the notes:", { docString: "press Escape" }).keys, []); // a doc string is a value, never a key
});

test("readStep: whole-Step navigation runs by code; anything else is Jev's (task 0041)", () => {
  const nav = (s: string) => action(s).navigation;
  assert.deepEqual(["I go back", "I go forward.", "I reload the page", "Refresh"].map(s => nav(s)?.verb), ["BACK", "FORWARD", "RELOAD", "RELOAD"]);
  assert.deepEqual(["I go to /settings", `I go to "?keys"`, `I open "https://example.com/a"`, "I navigate to #top", `I visit "./b.html"`].map(s => nav(s)?.value),
    ["/settings", "?keys", "https://example.com/a", "#top", "./b.html"]);
  assert.deepEqual(["I close the tab", "I close the new tab", "I switch back to the first tab", "I go back to the previous tab"].map(s => nav(s)?.verb),
    ["CLOSE_TAB", "CLOSE_TAB", "SWITCH_TAB", "SWITCH_TAB"]);
  // Page names, longer Steps and quoted non-URLs are Jev's.
  for (const s of ["I go back to the list", "I open the Settings page", "I go to the Settings page", `I open "Spring Sale"`, "I go to b.html"]) assert.equal(nav(s), undefined, s);
  assert.equal(check("I go back").navigation, undefined);
});

test("readStep: an action's table cell that cannot become a quoted value", () => {
  assert.equal(action("I fill in:", { table: [["Name", ""]] }).badCell, "");
  assert.equal(action("I fill in:", { table: [["Name", `say "hi"`]] }).badCell, `say "hi"`);
  assert.equal(action("I fill in:", { table: [["Name", "Ada"]] }).badCell, undefined);
  assert.equal(check("the form should show:", { table: [["Name", ""], ["", "x"]] }).badCell, undefined); // a check's table is compared, not quoted
});

test("readStep: a Step uploads only when it says upload or attach and quotes a file (task 0044)", () => {
  assert.equal(action(`I upload "a.txt" with the Attach button`).upload, true);
  assert.equal(action(`I attach "a.txt"`).upload, true);
  assert.equal(action(`I upload a file`).upload, false);
  assert.equal(action(`I enter "a.txt"`).upload, false);
});

test("readStep: clear/empty offers an empty TYPE candidate only in action wording", () => {
  assert.deepEqual(action("I clear Search").candidates, [""]);
  assert.deepEqual(action("I empty Search").candidates, [""]);
  assert.deepEqual(action('I type "clear"').candidates, ["clear"]);
  assert.deepEqual(action("I search").candidates, []);
  assert.deepEqual(check("Search is empty").candidates, []);
});
