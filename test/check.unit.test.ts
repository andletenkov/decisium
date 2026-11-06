import assert from "node:assert/strict";
import { test } from "node:test";
import { verdict } from "../src/check.ts";
import type { Assessment, Pick } from "../src/decision.ts";
import { parseSnapshot } from "../src/observation.ts";

const pick = (probabilities: Record<string, number>): Pick => ({
  choice: Object.keys(probabilities).sort((a, b) => probabilities[b] - probabilities[a])[0],
  probabilities,
});
const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({
  kind: pick({ value: 1 }),
  subject: pick({ e1: 1 }),
  area: pick({ page: 1 }),
  state: pick({ disabled: 1 }),
  ...overrides,
});

test("Check: plausible kinds must agree, and agreeing kinds carry the pass together", () => {
  const obs = parseSnapshot("- paragraph [ref=e1]: Draft");
  const expected = { values: ["Draft"] };
  assert.equal(verdict(assessment({ kind: pick({ value: 0.55, presence: 0.45 }) }), obs, expected).outcome, "PASSED");
  assert.deepEqual(verdict(assessment({ kind: pick({ value: 0.55, presence: 0.45 }) }), obs, expected).marginal, []);
  assert.equal(verdict(assessment({ kind: pick({ value: 0.55, absence: 0.45 }) }), obs, expected).outcome, "AMBIGUOUS");
});

test("Check: Jev vetoes any inexact match the surrounding words negate (issue #28)", () => {
  const obs = parseSnapshot("- paragraph [ref=e1]: Not Scheduled");
  const expected = { values: ["Scheduled"] };
  // No answer (older cassettes, any language): the containment match stands.
  assert.equal(verdict(assessment(), obs, expected).outcome, "PASSED");
  assert.equal(verdict(assessment({ satisfied: 0.02 }), obs, expected).outcome, "ASSERTION_FAILED");
  // The veto never touches an exact value: code alone decides equality.
  assert.equal(verdict(assessment({ satisfied: 0.02 }), obs, { values: ["Not Scheduled"] }).outcome, "PASSED");
  // Presence reads the same text, so it is vetoed the same way; absence then holds.
  const vetoed = (k: string) => ({ kind: pick({ [k]: 1 }), satisfied: 0.02 });
  assert.equal(verdict(assessment(vetoed("presence")), obs, expected).outcome, "ASSERTION_FAILED");
  assert.equal(verdict(assessment({ kind: pick({ absence: 1 }) }), obs, expected).outcome, "ASSERTION_FAILED");
  assert.equal(verdict(assessment(vetoed("absence")), obs, expected).outcome, "PASSED");
  // A table cell is matched the same way.
  const rows = parseSnapshot(`- table [ref=t1]:
  - row [ref=r0]:
    - columnheader [ref=c0]: Status
  - row [ref=r1]:
    - cell [ref=c1]: Not Scheduled`);
  const table = { values: [], table: [["Status"], ["Scheduled"]] };
  assert.equal(verdict(assessment(), rows, table).outcome, "PASSED");
  assert.equal(verdict(assessment({ satisfied: 0.02 }), rows, table).outcome, "ASSERTION_FAILED");
});

test("Check: subjects and areas agree on outcomes; only passes carry marginal warnings", () => {
  const obs = parseSnapshot(`- region "First" [ref=a1]:
  - paragraph [ref=e1]: Draft
- region "Second" [ref=a2]:
  - paragraph [ref=e2]: Scheduled`);
  const expected = { values: ["Draft"] };
  const subject = pick({ e1: 0.55, e2: 0.45 });
  assert.equal(verdict(assessment({ subject }), obs, expected).outcome, "AMBIGUOUS");
  assert.equal(verdict(assessment({ subject }), obs, { values: ["Deleted"] }).outcome, "ASSERTION_FAILED");
  const area = pick({ a1: 0.55, a2: 0.45 });
  for (const kind of ["presence", "absence"]) {
    assert.equal(verdict(assessment({ kind: pick({ [kind]: 1 }), area }), obs, expected).outcome, "AMBIGUOUS");
  }
  const weak = verdict(assessment({ subject: pick({ e1: 0.84, e2: 0.16 }) }), obs, expected);
  assert.equal(weak.outcome, "PASSED");
  assert.match(weak.marginal!.join("; "), /^subject: .*84%/);
  const failed = verdict(assessment({ subject: pick({ e2: 0.84, e1: 0.16 }) }), obs, expected);
  assert.equal(failed.outcome, "ASSERTION_FAILED");
  assert.equal(failed.marginal, undefined);
});

test("Check: table areas use the same agreement and marginal rule; exact rows and absence retain their meanings", () => {
  const obs = parseSnapshot(`- table "First" [ref=a1]:
  - row [ref=h1]:
    - columnheader "Product" [ref=c1]
    - columnheader "Qty" [ref=c2]
  - row [ref=r1]:
    - cell "Backpack" [ref=c3]
    - cell "2" [ref=c4]
- table "Second" [ref=a2]:
  - row [ref=h2]:
    - columnheader "Product" [ref=c5]
    - columnheader "Qty" [ref=c6]
  - row [ref=r2]:
    - cell "Backpack" [ref=c7]
    - cell "1" [ref=c8]`);
  const table = [
    ["Product", "Qty"],
    ["Backpack", "2"],
  ];
  const expected = { values: [], table };
  assert.equal(verdict(assessment({ area: pick({ a1: 0.55, a2: 0.45 }) }), obs, expected).outcome, "AMBIGUOUS");
  const weak = verdict(assessment({ area: pick({ a1: 0.84, a2: 0.16 }) }), obs, expected);
  assert.equal(weak.outcome, "PASSED");
  assert.match(weak.marginal!.join("; "), /^area: .*84%/);
  assert.equal(verdict(assessment({ area: pick({ a1: 1 }) }), obs, { ...expected, exact: true }).outcome, "PASSED");
  assert.equal(
    verdict(assessment({ area: pick({ a1: 1 }) }), obs, { ...expected, table: [...table, table[1]] }).outcome,
    "ASSERTION_FAILED",
  );
  assert.equal(
    verdict(assessment({ kind: pick({ absence: 1 }), area: pick({ a1: 1 }) }), obs, expected).outcome,
    "UNVERIFIABLE",
  );
});

test("Check: inapplicable readings contribute no confidence, but a label-only value remains unverifiable", () => {
  const obs = parseSnapshot(`- combobox "Period" [ref=e1]:
  - option "Draft" [selected]
- option "Draft" [selected] [ref=e2]
- button "Draft" [ref=e3]`);
  const expected = { values: ["Draft"] };
  const result = verdict(
    assessment({
      kind: pick({ state: 0.55, value: 0.45 }),
      state: pick({ selected: 1 }),
    }),
    obs,
    expected,
  );
  assert.equal(result.outcome, "PASSED");
  assert.match(result.marginal!.join("; "), /^kind:/);
  assert.equal(
    verdict(
      assessment({
        kind: pick({ state: 1 }),
        state: pick({ selected: 1 }),
        subject: pick({ e1: 0.55, e2: 0.45 }),
      }),
      obs,
      expected,
    ).outcome,
    "PASSED",
  );
  assert.equal(
    verdict(
      assessment({
        kind: pick({ value: 0.55, presence: 0.45 }),
        subject: pick({ e3: 1 }),
      }),
      obs,
      expected,
    ).outcome,
    "AMBIGUOUS",
  );
});

test("Check: judged outcomes, state and recall margins, and diagnostics need no Runtime or clock", () => {
  const obs = parseSnapshot('- button "Save" [disabled] [ref=e1]');
  for (const [judged, outcome] of [
    [undefined, "UNVERIFIABLE"],
    [0.95, "JUDGED_PASSED"],
    [0.05, "JUDGED_FAILED"],
    [0.5, "AMBIGUOUS"],
  ] as const) {
    assert.equal(verdict(assessment({ kind: pick({ fuzzy: 1 }), judged }), obs, { values: [] }).outcome, outcome);
  }
  const a = assessment({ kind: pick({ state: 1 }), state: pick({ disabled: 0.84, enabled: 0.16 }) });
  const expectation = { values: [], recall: pick({ Draft: 0.84, none: 0.16 }) };
  const before = structuredClone({ a, obs, expectation });
  const result = verdict(a, obs, expectation);
  assert.equal(result.outcome, "PASSED");
  assert.match(result.marginal!.join("; "), /earlier value:.*state:/);
  assert.match(result.details.join("\n"), /Kind: state=1.00.*\n.*Subject: e1=1.00 {2}State: disabled=0.84/);
  assert.deepEqual({ a, obs, expectation }, before);
});

import { containsValue } from "../src/check.ts";

test("containsValue: whole words, case and space insensitive, a space before punctuation dropped", () => {
  assert.equal(containsValue("11 weeks", "1 week"), false);
  assert.equal(containsValue("1 week ago", "1 WEEK"), true);
  assert.equal(containsValue("Added to cart !", "added to  cart!"), true);
  assert.equal(containsValue("1815London", "1815"), true);
  assert.equal(containsValue("1815London", "London"), true);
  assert.equal(containsValue("Londoner", "London"), false);
  assert.equal(containsValue("x12", "12"), true);
  assert.equal(containsValue("a (b) c", "(b)"), true);
  assert.equal(containsValue("$5.00", "$5.0"), false);
  assert.equal(containsValue("price: $5", "$5"), true);
  assert.equal(containsValue("a.b", "a*b"), false);
  assert.equal(containsValue("a ) b", "a)"), true);
  for (const p of ["!", "?", ".", ",", ";", ":", ")"]) assert.equal(containsValue(`x ${p}`, `x${p}`), true, p);
  assert.equal(containsValue("Été", "été"), true);
  assert.equal(containsValue("Étés", "été"), false);
  assert.equal(containsValue("x", ""), true);
});

const run = (snap: string, a: Partial<Assessment>, values: string[] | object = []) =>
  verdict(assessment(a), parseSnapshot(snap), Array.isArray(values) ? { values } : (values as { values: string[] }));
const reading = (r: ReturnType<typeof verdict>) => ({ outcome: r.outcome, reason: r.reason });

test("Check reasons: fuzzy, presence and absence", () => {
  const fuzzy = (judged?: number) => run("", { kind: pick({ fuzzy: 1 }), judged });
  assert.deepEqual(reading(fuzzy()), {
    outcome: "UNVERIFIABLE",
    reason: "this is a subjective check that code cannot compare; rerun with --judged to let Jev judge it",
  });
  assert.deepEqual(reading(fuzzy(0.8)), { outcome: "JUDGED_PASSED", reason: "p=0.80" });
  assert.deepEqual(reading(fuzzy(0.2)), { outcome: "JUDGED_FAILED", reason: "p=0.20" }); // 1 - 0.8 is 0.19999… in floats
  assert.deepEqual(reading(fuzzy(0.79)), {
    outcome: "AMBIGUOUS",
    reason: "Jev is unsure whether the page satisfies the check (79% yes)",
  });
  assert.equal(fuzzy(0.21).outcome, "AMBIGUOUS");
  assert.deepEqual(fuzzy(0.9).details, ["  Kind: fuzzy=1.00", "  Judged: p=0.90"]);

  const snap = `- region "R" [ref=a1]:\n  - paragraph [ref=e1]: Apple Pear\n- paragraph [ref=e2]: Plum`;
  const presence = { kind: pick({ presence: 1 }) };
  const absence = { kind: pick({ absence: 1 }) };
  assert.deepEqual(reading(run(snap, presence, [])), {
    outcome: "UNVERIFIABLE",
    reason: 'the check quotes no text to look for (e.g. "Winter Sale" should appear)',
  });
  assert.deepEqual(reading(run(snap, presence, ["Kiwi", "Apple"])), {
    outcome: "ASSERTION_FAILED",
    reason: '"Kiwi" and "Apple" is not shown in the page',
  });
  assert.deepEqual(run(snap, presence, ["Kiwi"]).details, ["  Kind: presence=1.00"]);
  assert.deepEqual(reading(run(snap, { ...presence, area: pick({ a1: 1 }) }, ["Apple", "Pear"])), {
    outcome: "PASSED",
    reason: undefined,
  });
  assert.deepEqual(run(snap, { ...presence, area: pick({ a1: 1 }) }, ["Apple"]).details, [
    "  Kind: presence=1.00",
    "  Area: a1=1.00",
  ]);
  assert.deepEqual(reading(run(snap, { ...presence, area: pick({ a1: 1 }) }, ["Plum"])), {
    outcome: "ASSERTION_FAILED",
    reason: `"Plum" is not shown in region "R"`,
  });
  assert.deepEqual(reading(run(snap, { ...absence, area: pick({ a1: 1 }) }, ["Kiwi", "Pear"])), {
    outcome: "ASSERTION_FAILED",
    reason: `"Kiwi" or "Pear" is shown in region "R", expected it to be absent`,
  });
  assert.deepEqual(reading(run(snap, absence, ["Kiwi"])), { outcome: "PASSED", reason: undefined });
  assert.deepEqual(reading(run(snap, { ...absence, area: pick({ a1: 1 }) }, ["Plum"])), {
    outcome: "PASSED",
    reason: undefined,
  });
  assert.deepEqual(reading(run(snap, { ...presence, area: pick({ missing: 1 }) }, ["Plum"])), {
    outcome: "ASSERTION_FAILED",
    reason: `"Plum" is not shown in the area the check names (that area is not on this screen)`,
  });
  assert.deepEqual(reading(run(snap, { ...presence, area: pick({ gone: 1 }) }, ["Plum"])), {
    outcome: "ELEMENT_NOT_FOUND",
    reason: "Jev chose an area that is no longer on the page (gone)",
  });
  const split = run(snap, { ...presence, area: pick({ a1: 0.5, page: 0.5 }) }, ["Plum"]);
  assert.deepEqual(reading(split), {
    outcome: "AMBIGUOUS",
    reason: `Jev is unsure where the check says to look, and the candidates give different answers: region "R" 50%, anywhere on the page 50%`,
  });
  assert.deepEqual(run(snap, { ...presence, area: pick({ a1: 0.9, page: 0.1 }) }, ["Apple"]).marginal, []);
  assert.deepEqual(run(snap, { ...presence, area: pick({ a1: 0.89, page: 0.11 }) }, ["Apple"]).marginal, [
    `area: region "R" 89%, anywhere on the page 11%`,
  ]);
  // agreeing readings: the last agreeing area is reported
  const both = run(snap, { ...presence, area: pick({ a1: 0.5, missing: 0.5 }) }, ["Plum"]);
  assert.equal(both.reason, `"Plum" is not shown in the area the check names (that area is not on this screen)`);
});

test("Check reasons: state", () => {
  const snap = [
    `- button "Save" [disabled] [ref=e1]`,
    `- checkbox "Agree" [checked] [ref=e2]`,
    `- link "Home" [ref=e3]`,
    `- link "Docs" [current] [ref=e4]`,
    `- tab "T" [selected] [ref=e5]`,
    `- button "Menu" [expanded] [pressed] [ref=e6]`,
    `- textbox "Name" [ref=e7]`,
  ].join("\n");
  const state = (subject: string, s: string) =>
    reading(run(snap, { kind: pick({ state: 1 }), subject: pick({ [subject]: 1 }), state: pick({ [s]: 1 }) }));
  const pass = { outcome: "PASSED", reason: undefined };
  for (const [ref, s] of [
    ["e1", "disabled"],
    ["e2", "checked"],
    ["e4", "selected"],
    ["e5", "selected"],
    ["e6", "expanded"],
    ["e6", "pressed"],
    ["e7", "enabled"],
    ["e3", "unselected"],
    ["e3", "collapsed"],
    ["e1", "unpressed"],
    ["e7", "unchecked".replace("unchecked", "enabled")],
  ])
    assert.deepEqual(state(ref, s), pass, `${ref} ${s}`);
  assert.deepEqual(state("e1", "enabled"), {
    outcome: "ASSERTION_FAILED",
    reason: `expected button "Save" [disabled] to be enabled, but it is not`,
  });
  assert.deepEqual(state("e2", "unchecked"), {
    outcome: "ASSERTION_FAILED",
    reason: `expected checkbox "Agree" [checked] to be unchecked, but it is not`,
  });
  assert.deepEqual(state("e7", "checked"), { outcome: "UNVERIFIABLE", reason: "a textbox cannot be checked" });
  assert.deepEqual(state("e7", "pressed"), { outcome: "UNVERIFIABLE", reason: "a textbox cannot be pressed" });
  assert.deepEqual(state("e7", "selected"), { outcome: "UNVERIFIABLE", reason: "a textbox cannot be selected" });
  assert.deepEqual(state("e7", "expanded"), { outcome: "UNVERIFIABLE", reason: "a textbox cannot be expanded" });
  assert.deepEqual(state("none", "disabled"), {
    outcome: "ASSERTION_FAILED",
    reason: "no element on the page matches what the check describes",
  });
  assert.deepEqual(state("gone", "disabled"), {
    outcome: "ELEMENT_NOT_FOUND",
    reason: "Jev chose an element that is no longer on the page (gone)",
  });
  assert.deepEqual(reading(run(snap, { kind: pick({ state: 1 }), state: pick({ disabled: 0.6, enabled: 0.4 }) })), {
    outcome: "AMBIGUOUS",
    reason: "Jev is unsure which state the check means: disabled 60%, enabled 40%",
  });
  const split = run(snap, {
    kind: pick({ state: 1 }),
    subject: pick({ e1: 0.5, e7: 0.5 }),
    state: pick({ disabled: 1 }),
  });
  assert.deepEqual(reading(split), {
    outcome: "AMBIGUOUS",
    reason: `Jev is unsure which control the check is about, and they give different answers: button "Save" [disabled] 50%, textbox "Name" 50%`,
  });
  assert.deepEqual(run(snap, { kind: pick({ state: 1 }), state: pick({ disabled: 1 }) }).marginal, []);
  assert.deepEqual(run(snap, { kind: pick({ state: 1 }), state: pick({ disabled: 0.89, enabled: 0.11 }) }).marginal, [
    "state: disabled 89%, enabled 11%",
  ]);
  assert.deepEqual(run(snap, { kind: pick({ state: 1 }), state: pick({ disabled: 0.9, enabled: 0.1 }) }).marginal, []);
});

test("Check reasons: value", () => {
  const snap = [
    `- paragraph [ref=e1]: Draft`,
    `- button "Go" [ref=e2]`,
    `- textbox "Name" [ref=e3]: Ada`,
    `- paragraph [ref=e4]:`,
    `  - link "2" [ref=e5]`,
    `  - text: items left`,
    `- paragraph [ref=e6]:`,
    `  - link "Not" [ref=e7]`,
    `  - text: done`,
  ].join("\n");
  const value = (ref: string, v: string[], more: Partial<Assessment> = {}) =>
    run(snap, { subject: pick({ [ref]: 1 }), ...more }, v);
  assert.deepEqual(reading(value("e1", [])), {
    outcome: "UNVERIFIABLE",
    reason: 'a value check needs exactly one quoted expected value (e.g. the status should be "Draft")',
  });
  assert.equal(value("e1", ["a", "b"]).outcome, "UNVERIFIABLE");
  assert.deepEqual(value("e1", ["Draft"]).details, [
    "  Kind: value=1.00",
    "  Subject: e1=1.00",
    `  Compare: "Draft" in "Draft"`,
  ]);
  assert.deepEqual(reading(value("e2", ["Go"])), {
    outcome: "UNVERIFIABLE",
    reason: `button "Go" has no text to compare (only a label)`,
  });
  assert.deepEqual(reading(value("none", ["Go"])), {
    outcome: "ASSERTION_FAILED",
    reason: "no element on the page shows what the check describes",
  });
  assert.deepEqual(reading(value("gone", ["Go"])), {
    outcome: "ELEMENT_NOT_FOUND",
    reason: "Jev chose an element that is no longer on the page (gone)",
  });
  assert.deepEqual(reading(value("e3", ["Bob"])), {
    outcome: "ASSERTION_FAILED",
    reason: `expected "Bob", but textbox "Name" shows "Ada"`,
  });
  assert.deepEqual(reading(value("e1", ["Final"])), {
    outcome: "ASSERTION_FAILED",
    reason: `expected "Final", but paragraph shows "Draft"`,
  });
  assert.equal(value("e5", ["2 items left"]).outcome, "PASSED");
  assert.deepEqual(
    value("e5", ["2 items left"]).details.at(-1),
    `  Compare: "2 items left" in "2 items left" (paragraph value="2 items left", holding link "2")`,
  );
  assert.deepEqual(reading(value("e5", ["2 items right"])), {
    outcome: "ASSERTION_FAILED",
    reason: `expected "2 items right", but link shows "2"`,
  });
  assert.deepEqual(reading(value("e7", ["done"], { satisfied: 0.1 })), {
    outcome: "ASSERTION_FAILED",
    reason: `expected "done", but link shows "Not"`,
  });
  const vetoed = value(
    "e1",
    ["Draft"].map(() => "Dra"),
    { satisfied: 0.1 },
  );
  assert.equal(vetoed.outcome, "ASSERTION_FAILED");
  const negated = run(`- paragraph [ref=e1]: Not Draft`, { satisfied: 0.2 }, ["Draft"]);
  assert.deepEqual(reading(negated), {
    outcome: "ASSERTION_FAILED",
    reason: `expected "Draft", but paragraph shows "Not Draft"`,
  });
  assert.equal(negated.details.at(-1), `  Jev reads "Not Draft" as not satisfying the check (p=0.20)`);
  assert.equal(run(`- paragraph [ref=e1]: Not Draft`, { satisfied: 0.21 }, ["Draft"]).outcome, "PASSED");
});

test("Check reasons: URL and download pseudo-elements", async () => {
  const { withPage, withDownload } = await import("../src/observation.ts");
  const obs = withDownload(withPage(parseSnapshot(""), "https://x.test/Path/a", "T"), { name: "e.txt", size: 0 });
  const value = (ref: string, v: string) => verdict(assessment({ subject: pick({ [ref]: 1 }) }), obs, { values: [v] });
  assert.equal(value("url", "/Path/a").outcome, "PASSED");
  assert.equal(value("url", "Pat").outcome, "PASSED");
  assert.deepEqual(reading(value("url", "/path/a")), {
    outcome: "ASSERTION_FAILED",
    reason: `expected the URL to contain "/path/a", but it is "https://x.test/Path/a"`,
  });
  assert.deepEqual(reading(value("download", "e.txt")), {
    outcome: "ASSERTION_FAILED",
    reason: "the downloaded file is empty (0 bytes)",
  });
  const full = withDownload(parseSnapshot(""), { name: "f.txt", size: 3, text: "abc" });
  assert.equal(verdict(assessment({ subject: pick({ download: 1 }) }), full, { values: ["abc"] }).outcome, "PASSED");
});

test("Check reasons: kinds disagree, none applies, table shapes", () => {
  const snap = `- paragraph [ref=e1]: Draft`;
  assert.deepEqual(reading(run(snap, { kind: pick({ value: 0.5, absence: 0.5 }) }, ["Draft"])), {
    outcome: "AMBIGUOUS",
    reason:
      'Jev could not tell what kind of check this is, and the readings disagree: as a value check it is PASSED; as a absence check it is ASSERTION_FAILED ("Draft" is shown in the page, expected it to be absent)',
  });
  assert.deepEqual(run(snap, { kind: pick({ value: 0.89, presence: 0.11 }) }, ["Draft"]).marginal, [
    "kind: value 89%, presence 11%",
  ]);
  assert.deepEqual(run(snap, { kind: pick({ value: 0.9, presence: 0.1 }) }, ["Draft"]).marginal, []);
  assert.deepEqual(
    run(snap, { kind: pick({ value: 0.89, state: 0.11 }), subject: pick({ e1: 1 }) }, ["Draft"]).outcome,
    "PASSED",
  );
  const both = run(`- button "Go" [ref=e1]`, { kind: pick({ value: 0.5, state: 0.5 }), state: pick({ checked: 1 }) }, [
    "Go",
  ]);
  assert.deepEqual(reading(both), {
    outcome: "UNVERIFIABLE",
    reason: `button "Go" has no text to compare (only a label)`, // a value check on a label stays final
  });
  assert.deepEqual(
    reading(run(snap, { kind: pick({ presence: 0.5, absence: 0.5 }) }, { values: [], table: [["a"], ["b"]] })),
    {
      outcome: "UNVERIFIABLE",
      reason: "a check that table rows are not shown is not supported; check each row's absence in its own Step",
    },
  );
  // a list (one column, no header) is a presence check per item, or absence
  const list = { values: ["Draft"], table: [["Draft"]], list: true };
  assert.equal(run(snap, { kind: pick({ value: 1 }) }, list).outcome, "PASSED");
  assert.equal(run(snap, { kind: pick({ absence: 1 }) }, list).outcome, "ASSERTION_FAILED");
  assert.deepEqual(run(snap, { kind: pick({ value: 0.6, state: 0.4 }) }, list).marginal, []);
  assert.equal(run(snap, { kind: pick({ value: 0.5, absence: 0.5 }) }, list).outcome, "AMBIGUOUS");
});

const grid = `- table "Cart" [ref=t1]:
  - row [ref=h1]:
    - columnheader "Product ▲" [ref=c1]
    - columnheader "Qty" [ref=c2]
    - columnheader "Note" [ref=c9]
  - row [ref=r1]:
    - cell "Pen" [ref=c3]
    - cell "2" [ref=c4]
    - cell [ref=c10]
  - row [ref=r2]:
    - cell "Ink" [ref=c5]
    - cell "1" [ref=c6]
    - cell "gift" [ref=c11]
- grid "Other" [ref=t2]:
  - row [ref=h2]:
    - columnheader "Product" [ref=c7]
  - row [ref=r3]:
    - cell "Cap" [ref=c8]
- list "Empty" [ref=l1]:
  - listitem "x" [ref=i1]`;

test("Check reasons: table rows", () => {
  const rows = (table: string[][], area: Record<string, number> = { t1: 1 }, exact = false) =>
    reading(run(grid, { area: pick(area) }, { values: [], table, exact }));
  const pass = { outcome: "PASSED", reason: undefined };
  assert.deepEqual(
    rows([
      ["Product", "Qty"],
      ["Ink", "1"],
      ["Pen", "2"],
    ]),
    pass,
  );
  assert.deepEqual(
    rows([
      ["qty", "Product"],
      ["2", "Pen"],
    ]),
    pass,
  );
  assert.deepEqual(
    rows([
      ["Product", "Note"],
      ["Pen", ""],
    ]),
    pass,
  );
  assert.deepEqual(
    rows([
      ["Product", "Note"],
      ["Ink", ""],
    ]),
    {
      outcome: "ASSERTION_FAILED",
      reason: `expected row Product=Ink, Note= is not in table "Cart"; its rows: Pen | 2 | ; Ink | 1 | gift`,
    },
  );
  assert.deepEqual(rows([["Product"], ["Pen"], ["Pen"]]), {
    outcome: "ASSERTION_FAILED",
    reason: `expected row Product=Pen is not in table "Cart"; its rows: Pen | 2 | ; Ink | 1 | gift`,
  });
  assert.deepEqual(rows([["Price"], ["1"]]), {
    outcome: "ASSERTION_FAILED",
    reason: `the table in table "Cart" has no column "Price" (columns: Product ▲, Qty, Note)`,
  });
  assert.deepEqual(rows([["Product"], ["Pen"], ["Ink"]], { t1: 1 }, true), pass);
  assert.deepEqual(rows([["Product"], ["Ink"], ["Pen"]], { t1: 1 }, true), {
    outcome: "ASSERTION_FAILED",
    reason: `expected exactly these rows in this order: Product=Ink; Product=Pen; table "Cart" has its rows: Pen | 2 | ; Ink | 1 | gift`,
  });
  assert.equal(rows([["Product"], ["Pen"]], { t1: 1 }, true).outcome, "ASSERTION_FAILED");
  assert.deepEqual(rows([["Product"], ["Cap"]], { page: 1 }), pass);
  assert.deepEqual(rows([["Product"], ["Cap"]], { t1: 1 }).outcome, "ASSERTION_FAILED");
  assert.deepEqual(rows([["Product"], ["Cap"]], { l1: 1 }), {
    outcome: "ASSERTION_FAILED",
    reason: `list "Empty" shows no table rows`,
  });
  assert.deepEqual(rows([["Product"], ["Cap"]], { missing: 1 }), {
    outcome: "ASSERTION_FAILED",
    reason: "the table the check names is not on this screen",
  });
  assert.deepEqual(rows([["Product"], ["Cap"]], { gone: 1 }), {
    outcome: "ELEMENT_NOT_FOUND",
    reason: "Jev chose an area that is no longer on the page (gone)",
  });
  assert.equal(rows([["Product"], ["Cap"]], { t1: 0.5, t2: 0.5 }).outcome, "AMBIGUOUS");
  assert.deepEqual(run(grid, {}, { values: [], table: [["Product"], ["Cap"]] }).details, [
    "  Kind: value=1.00",
    "  Area: page=1.00",
  ]);
});

test("Check: a recall marginal only on a pass", () => {
  const snap = `- paragraph [ref=e1]: Draft`;
  const recall = pick({ Draft: 0.85, none: 0.15 });
  assert.deepEqual(verdict(assessment(), parseSnapshot(snap), { values: ["Draft"], recall }).marginal, [
    "earlier value: Draft 85%, nothing 15%",
  ]);
  assert.equal(
    verdict(assessment(), parseSnapshot(snap), { values: ["Draft"], recall: pick({ Draft: 1 }) }).marginal?.length,
    0,
  );
  assert.equal(verdict(assessment(), parseSnapshot(snap), { values: ["X"], recall }).marginal, undefined);
  assert.deepEqual(reading(verdict(assessment(), parseSnapshot(""), { values: ["X"] })), {
    outcome: "ELEMENT_NOT_FOUND",
    reason: "Jev chose an element that is no longer on the page (e1)",
  });
});
