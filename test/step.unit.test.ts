import assert from "node:assert/strict";
import { test } from "node:test";
import { readStep, spans, withIntent, type ParsedStep } from "../src/step.ts";

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
  const rows = check("the cart should list:", {
    table: [
      ["Product", "Qty"],
      ["Backpack", "2"],
    ],
  });
  assert.deepEqual([rows.values, rows.list, rows.header], [[], false, true]);
  assert.deepEqual(
    [check("the cart should show exactly:").exact, check("the rows in this order").exact, check("the cart").exact],
    [true, true, false],
  );
});

test("readStep: labels for reports and cassette keys, and an action's table as one Step per row", () => {
  assert.equal(
    action("I fill in the form:", {
      table: [
        ["First name", "Ada"],
        ["Last name", "Lovelace"],
      ],
    }).label,
    "I fill in the form: [First name=Ada, Last name=Lovelace]",
  );
  assert.equal(
    action("I write the notes:", { docString: `Line one.\nLine "two".` }).label,
    `I write the notes: "Line one.\\nLine \\"two\\"."`,
  );
  assert.equal(
    check("the cart should list:", {
      table: [
        ["Product", "Qty"],
        ["Backpack", "2"],
      ],
    }).label,
    "the cart should list: [Product=Backpack, Qty=2]",
  );
  assert.equal(
    action("I add these:", { table: [["Backpack"], ["Bike Light"]] }).label,
    "I add these: [Backpack, Bike Light]",
  );
  assert.equal(action("I go back").label, "I go back");
  assert.deepEqual(
    action("I fill in the form:", {
      table: [
        ["First name", "Ada"],
        ["Last name", "Lovelace"],
      ],
    }).rows,
    [`I enter "Ada" as First name`, `I enter "Lovelace" as Last name`],
  );
  assert.deepEqual(action("I add these products to the cart:", { table: [["Backpack"], ["Bike Light"]] }).rows, [
    `I add these products to the cart "Backpack"`,
    `I add these products to the cart "Bike Light"`,
  ]);
  assert.deepEqual(
    action("I order:", {
      table: [
        ["Product", "Quantity", "Gift"],
        ["Backpack", "2", "no"],
      ],
    }).rows,
    [`I order Product "Backpack", Quantity "2", Gift "no"`],
  );
  assert.deepEqual(action("I order:", { table: [["Product", "Quantity", "Gift"]] }).rows, []); // a header alone
  assert.deepEqual(check("the cart should show:", { table: [["Backpack"]] }).rows, ["the cart should show:"]); // a check runs once
  assert.deepEqual(action("I go back").rows, ["I go back"]);
});

test("readStep: Secret placeholders, quoted, as the doc string or as a table cell", () => {
  assert.deepEqual(action(`I log in as "$USER"`, { docString: "$NOTE" }).placeholders, ["$USER", "$NOTE"]);
  assert.deepEqual(
    action("I fill in the form:", {
      table: [
        ["Password", "$PW"],
        ["Name", "Ada"],
      ],
    }).placeholders,
    ["$PW"],
  );
});

test("readStep: a check or uncheck Step that does nothing else names the box state it wants", () => {
  assert.deepEqual(
    [`I check "A"`, "I uncheck checkbox 2", `I check "A" and submit`, "I open the page"].map((s) => action(s).toggle),
    [true, false, undefined, true],
  );
  assert.deepEqual(
    ["I accept the terms", "I disable dark mode", "I opt out of tracking", "I unsubscribe"].map(
      (s) => action(s).toggle,
    ),
    [true, false, false, false],
  );
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
  assert.deepEqual(
    ["F2", "Return", "Space", "Backspace", "Delete", "Home", "page up", "arrow left", "Tab"].map(
      (k) => keys(`press ${k}`)[0],
    ),
    ["F2", "Enter", "Space", "Backspace", "Delete", "Home", "PageUp", "ArrowLeft", "Tab"],
  );
  // Not keys: clicking a button by its name, words that are not after press/hit.
  for (const s of [`I press the "Save" button`, "I press Save", "I delete the campaign", "I open the Settings tab"])
    none(s);
  // A key the Step means but that is not a key name.
  assert.deepEqual(action("I press the Foo key").unknownKeys, ["Foo"]);
  assert.deepEqual(action("I press Ctrl+Kay").unknownKeys, ["Ctrl+Kay"]);
  // A Step that is only "press X": code presses it.
  assert.deepEqual(
    [
      "I press Escape",
      `press "Tab"`,
      "I hit the down arrow.",
      "I press Ctrl+K",
      "I press Escape to close the dialog",
      "I press the Save button",
    ].map((s) => action(s).pressOnly),
    ["Escape", "Tab", "ArrowDown", "Control+K", undefined, undefined],
  );
  // A button or link named like a key is clicked, not pressed; quoted text to type names no key.
  for (const s of [
    "I press the Delete button",
    "I hit the Home link",
    `I type "press Escape to quit" in the note`,
    `I write the notes: "hit Tab"`,
  ])
    none(s);
  assert.deepEqual(keys(`I type "Ada" and press "Tab"`), ["Tab"]);
  assert.deepEqual(keys("I press the Delete key"), ["Delete"]);
  assert.deepEqual(action("I write the notes:", { docString: "press Escape" }).keys, []); // a doc string is a value, never a key
});

test("readStep: whole-Step navigation runs by code; anything else is Jev's (task 0041)", () => {
  const nav = (s: string) => action(s).navigation;
  assert.deepEqual(
    ["I go back", "I go forward.", "I reload the page", "Refresh"].map((s) => nav(s)?.verb),
    ["BACK", "FORWARD", "RELOAD", "RELOAD"],
  );
  assert.deepEqual(
    [
      "I go to /settings",
      `I go to "?keys"`,
      `I open "https://example.com/a"`,
      "I navigate to #top",
      `I visit "./b.html"`,
    ].map((s) => nav(s)?.value),
    ["/settings", "?keys", "https://example.com/a", "#top", "./b.html"],
  );
  assert.deepEqual(
    ["I close the tab", "I close the new tab", "I switch back to the first tab", "I go back to the previous tab"].map(
      (s) => nav(s)?.verb,
    ),
    ["CLOSE_TAB", "CLOSE_TAB", "SWITCH_TAB", "SWITCH_TAB"],
  );
  // Page names, longer Steps and quoted non-URLs are Jev's.
  for (const s of [
    "I go back to the list",
    "I open the Settings page",
    "I go to the Settings page",
    `I open "Spring Sale"`,
    "I go to b.html",
  ])
    assert.equal(nav(s), undefined, s);
  assert.equal(check("I go back").navigation, undefined);
});

test("readStep: an action's table cell that cannot become a quoted value", () => {
  assert.equal(action("I fill in:", { table: [["Name", ""]] }).badCell, "");
  assert.equal(action("I fill in:", { table: [["Name", `say "hi"`]] }).badCell, `say "hi"`);
  assert.equal(action("I fill in:", { table: [["Name", "Ada"]] }).badCell, undefined);
  assert.equal(
    check("the form should show:", {
      table: [
        ["Name", ""],
        ["", "x"],
      ],
    }).badCell,
    undefined,
  ); // a check's table is compared, not quoted
});

test("readStep: a Step uploads only when it says upload or attach and quotes a file (task 0044)", () => {});

test("readStep: clear/empty offers an empty TYPE candidate only in action wording", () => {
  assert.deepEqual(action("I clear Search").candidates, [""]);
  assert.deepEqual(action("I empty Search").candidates, [""]);
  assert.deepEqual(action('I type "clear"').candidates, ["clear"]);
  assert.deepEqual(action("I search").candidates, []);
  assert.deepEqual(check("Search is empty").candidates, []);
});

test("readStep: a Step pastes only when it says paste and quotes nothing (task 0062)", () => {});

test("withIntent: Jev fills only what the wording rules missed (issue #31)", () => {
  // Rules first: a quoted value, a key or a navigation they read is kept.
  const quoted = withIntent(action(`I enter "Winter Sale" as the name`), { value: "Winter", key: "Enter" });
  assert.deepEqual([quoted.candidates, quoted.keys], [["Winter Sale"], ["Enter"]]);
  assert.deepEqual(withIntent(action("I go back"), { navigation: "RELOAD" }).navigation, { verb: "BACK" });
  // Unquoted value, key, navigation, toggle off, attempt: added.
  assert.deepEqual(withIntent(action("I enter Winter Sale as the name"), { value: "Winter Sale" }).candidates, [
    "Winter Sale",
  ]);
  assert.equal(withIntent(action("I close the dialog with the escape key"), { key: "Escape" }).keys[0], "Escape");
  assert.equal(withIntent(action("I hit escape now"), { key: "Escape", pressOnly: true }).pressOnly, "Escape");
  assert.deepEqual(withIntent(action("I return to the previous page"), { navigation: "BACK" }).navigation, {
    verb: "BACK",
  });
  assert.equal(withIntent(action("I make sure the newsletter is off"), { toggle: false }).toggle, false);
  assert.equal(withIntent(action("I accept the terms and continue"), { toggle: true }).toggle, true); // "and": rules read none
  assert.equal(withIntent(action("I submit the empty form"), { attempt: true }).attempt, true);
  // GOTO needs something URL-like: a page name is Jev's turn, not a navigation.
  assert.equal(
    withIntent(action("I visit the settings page"), { navigation: "GOTO", value: "settings page" }).navigation,
    undefined,
  );
  assert.deepEqual(withIntent(action("I visit /settings now"), { navigation: "GOTO", value: "/settings" }).navigation, {
    verb: "GOTO",
    value: "/settings",
  });
  // Checks: an unquoted expected value and exactness.
  const c = withIntent(check("the status should be Scheduled"), { value: "Scheduled", exact: true });
  assert.deepEqual([c.values, c.exact], [["Scheduled"], true]);
  assert.deepEqual(withIntent(action("je vide le champ de recherche"), { clear: true }).candidates, [""]);
  // No intent: the rules' reading unchanged.
  assert.deepEqual(withIntent(action(`I press Escape`)), { ...action(`I press Escape`), attempt: undefined });
});

test("spans: word runs up to 8 words, quotes and trailing punctuation dropped", () => {
  assert.deepEqual(spans(`I add "Milk".`), ["I", "I add", "I add Milk", "add", "add Milk", "Milk"]);
  assert.equal(spans("a b c d e f g h i j").includes("a b c d e f g h i"), false);
});

import { placeholder, stepKind } from "../src/step.ts";

const act = (text: string) => readStep({ text, kind: "action" });

test("readStep: navigation forms, table-driven", () => {
  const cases: [string, unknown][] = [
    ["I go back", { verb: "BACK" }],
    ["Go back.", { verb: "BACK" }],
    ["I  go  back", { verb: "BACK" }],
    ["I navigate forward!", { verb: "FORWARD" }],
    ["browses back", { verb: "BACK" }],
    ["I reload", { verb: "RELOAD" }],
    ["I refresh the page", { verb: "RELOAD" }],
    ["reloads page", { verb: "RELOAD" }],
    ["I close the tab", { verb: "CLOSE_TAB" }],
    ["closes this new tab", { verb: "CLOSE_TAB" }],
    ["I switch back to the previous tab", { verb: "SWITCH_TAB" }],
    ["goes back to the original tab", { verb: "SWITCH_TAB" }],
    ["I go to /x", { verb: "GOTO", value: "/x" }],
    [`I open "https://a.b/c"`, { verb: "GOTO", value: "https://a.b/c" }],
    ["visits ?q=1", { verb: "GOTO", value: "?q=1" }],
    ["I browse to #top", { verb: "GOTO", value: "#top" }],
    ["I go to ../up", { verb: "GOTO", value: "../up" }],
    ["I go to ./here", { verb: "GOTO", value: "./here" }],
    ["I open x1+y://z", { verb: "GOTO", value: "x1+y://z" }],
    ["I visit Settings", undefined],
    ["I open 1x://z", undefined],
    ["I go to the settings page", undefined],
    ["I go back to the list", undefined],
    ["Then I go back", undefined],
    ["I go backward", undefined],
    ["I reload it", undefined],
    ["I close the tab now", undefined],
    ["I closed the tab", undefined],
    ["I switch back to the previous tab please", undefined],
  ];
  for (const [text, want] of cases) assert.deepEqual(act(text).navigation, want, text);
  assert.equal(readStep({ text: "I go back", kind: "assertion" }).navigation, undefined);
});

test("readStep: key names, aliases, combos, press-only, table-driven", () => {
  const cases: [string, string[], string[], string | undefined][] = [
    ["I press Escape", ["Escape"], [], "Escape"],
    ["I press the esc key", ["Escape"], [], "Escape"],
    ["press del", ["Delete"], [], "Delete"],
    ["I hit Ctrl+K", ["Control+K"], [], "Control+K"],
    ["I press cmd + c", ["Meta+c"], [], "Meta+c"],
    ["I press command+option+i", ["Meta+Alt+i"], [], "Meta+Alt+i"],
    ["I press page down", ["PageDown"], [], "PageDown"],
    ["I press page up", ["PageUp"], [], "PageUp"],
    ["press up arrow", ["ArrowUp"], [], "ArrowUp"],
    ["press down arrow", ["ArrowDown"], [], "ArrowDown"],
    ["press left arrow", ["ArrowLeft"], [], "ArrowLeft"],
    ["press right arrow", ["ArrowRight"], [], "ArrowRight"],
    ["press arrow up", ["ArrowUp"], [], "ArrowUp"],
    ["press arrow down", ["ArrowDown"], [], "ArrowDown"],
    ["press arrow left", ["ArrowLeft"], [], "ArrowLeft"],
    ["press arrow right", ["ArrowRight"], [], "ArrowRight"],
    ["press F12", ["F12"], [], "F12"],
    ["press F1", ["F1"], [], "F1"],
    ["press F13", [], [], undefined],
    [`press "a"`, ["a"], [], "a"],
    ["press a", [], [], undefined],
    [`press Tab and type "x"`, ["Tab"], [], undefined],
    ["I press the Delete button", [], [], undefined],
    ["I press the Delete buttons", [], [], undefined],
    ["press Foo+Bar", [], ["Foo+Bar"], undefined],
    ["press Foo key", [], ["Foo"], undefined],
    ["press Foo now", [], [], undefined],
    ["I hit the return", ["Enter"], [], "Enter"],
    ["I hits Enter", ["Enter"], [], "Enter"],
    ["I presses Enter.", ["Enter"], [], "Enter"],
    ["pressing Space", ["Space"], [], undefined],
    [`I press "Enter" in "x"`, ["Enter"], [], undefined],
    [`type "press Tab" in it`, [], [], undefined],
    ["press Shift+Tab then press Enter", ["Shift+Tab", "Enter"], [], undefined],
    ["I press   Escape  ", ["Escape"], [], "Escape"],
  ];
  for (const [text, keys, unknown, only] of cases) {
    const r = act(text);
    assert.deepEqual([r.keys, r.unknownKeys, r.pressOnly], [keys, unknown, only], text);
  }
  const check = readStep({ text: "press Escape", kind: "assertion" });
  assert.deepEqual([check.keys, check.unknownKeys, check.pressOnly], [[], [], undefined]);
});

test("readStep: toggle wording, numbers and clear, table-driven", () => {
  const toggles: [string, boolean | undefined][] = [
    ["I uncheck News", false],
    ["I untick it", false],
    ["deselect it", false],
    ["I clear it", false],
    ["I turn off X", false],
    ["I switch off X", false],
    ["disable X", false],
    ["I check A and B", undefined],
    ["I check A then B", undefined],
    ["I check A, B", undefined],
    ["I decline cookies", false],
    ["I opt out", false],
    ["I unsubscribe now", false],
    ["I reject all", false],
    ["I accept", true],
    ["I enable X", true],
  ];
  for (const [text, want] of toggles) assert.equal(act(text).toggle, want, text);
  assert.deepEqual(act("I wait 5 seconds and 2.5 and 3,5 kg 10").candidates, ["5 seconds", "2.5", "3,5 kg", "10"]);
  assert.deepEqual(act("I type 5 into the field").candidates, ["5"]);
  assert.deepEqual(act("I add 3 to the cart").candidates, ["3"]);
  assert.deepEqual(act(`I clear the "empty" field`).candidates, ["empty", ""]);
  assert.deepEqual(act(`I type "x" into empty`).candidates, ["x", ""]);
  assert.deepEqual(act(`I type "clear"`).candidates, ["clear"]);
  assert.deepEqual(readStep({ text: "it should be empty", kind: "assertion" }).candidates, []);
  assert.deepEqual(readStep({ text: "it should show 5 items", kind: "assertion" }).candidates, ["5 items"]);
});

test("stepKind, placeholder, spans limits", () => {
  assert.deepEqual(
    ["I try to x", "try x", "I attempts", "Tries it", "I trying", "x I try"].map((text) => stepKind({ text })),
    ["attempt", "attempt", "attempt", "attempt", "action", "action"],
  );
  assert.equal(stepKind({ text: "I try", type: "Outcome" as never }), "assertion");
  assert.equal(stepKind({ text: "I try", type: "Action" as never }), "attempt");
  assert.deepEqual(["$A_b1", "$1a", "x$A", "$A ", "$_", "$"].map(placeholder), [
    "A_b1",
    undefined,
    undefined,
    undefined,
    "_",
    undefined,
  ]);
  assert.equal(spans("a b c d e f g h i j").length, 52);
  assert.ok(spans("a b c d e f g h i j").includes("a b c d e f g h"));
  assert.ok(!spans("a b c d e f g h i j").includes("a b c d e f g h i"));
  assert.deepEqual(spans(`Hello,  world!! "x".`), ["Hello", "Hello world", "Hello world x", "world", "world x", "x"]);
  assert.deepEqual(spans(""), []);
});

test("withIntent: each field only where the rules read their default", () => {
  const base = act("I do it");
  assert.equal(withIntent(base).attempt, undefined);
  assert.equal(withIntent(base, { attempt: true }).attempt, true);
  assert.equal(withIntent(base, { exact: true }).exact, true);
  assert.equal(withIntent(base, { exact: false }).exact, false);
  assert.deepEqual(withIntent(base, { clear: true }).candidates, [""]);
  assert.deepEqual(withIntent(act("I clear it"), { clear: true }).candidates, [""]);
  assert.deepEqual(withIntent(base, { key: "Enter" }).keys, ["Enter"]);
  assert.equal(withIntent(base, { key: "Enter" }).pressOnly, undefined);
  assert.equal(withIntent(base, { key: "Enter", pressOnly: true }).pressOnly, "Enter");
  assert.equal(withIntent(base, { pressOnly: true }).pressOnly, undefined);
  assert.deepEqual(withIntent(act("press Escape"), { key: "Enter", pressOnly: true }).keys, ["Escape"]);
  assert.equal(withIntent(act("press Escape"), { key: "Enter", pressOnly: true }).pressOnly, "Escape");
  assert.equal(withIntent(act("I go back"), { key: "Enter", pressOnly: true }).pressOnly, undefined);
  assert.equal(withIntent(base, { toggle: false }).toggle, false);
  assert.equal(withIntent(act("I check A and B"), { toggle: true }).toggle, true);
  assert.equal(withIntent(act("I uncheck A"), { toggle: true }).toggle, false);
  assert.equal(withIntent(act("I check A and B"), {}).toggle, undefined);
  assert.equal(withIntent(base, { toggle: true }).toggle, true);
  assert.deepEqual(withIntent(base, { navigation: "BACK" }).navigation, { verb: "BACK" });
  assert.deepEqual(withIntent(act("I go back"), { navigation: "RELOAD" }).navigation, { verb: "BACK" });
  assert.equal(withIntent(base, { navigation: "BACK", key: "Escape", pressOnly: true }).navigation, undefined);
  assert.deepEqual(withIntent(base, { navigation: "GOTO", value: "/a" }).navigation, { verb: "GOTO", value: "/a" });
  assert.deepEqual(withIntent(act(`I open "x://y" now`), { navigation: "GOTO" }).navigation, {
    verb: "GOTO",
    value: "x://y",
  });
  assert.equal(withIntent(base, { navigation: "GOTO", value: "Settings" }).navigation, undefined);
  assert.equal(withIntent(base, { navigation: "GOTO" }).navigation, undefined);
  assert.equal(withIntent(base, { navigation: "GOTO", value: "1a://b" }).navigation, undefined);
  const q = withIntent(act(`I type "a"`), { value: "b" });
  assert.deepEqual([q.values, q.candidates], [["a"], ["a"]]);
  const v = withIntent(act("I type 5 kg"), { value: "Ada" });
  assert.deepEqual([v.values, v.candidates], [["Ada"], ["Ada", "5 kg"]]);
});
