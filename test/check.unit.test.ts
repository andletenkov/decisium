import assert from "node:assert/strict";
import { test } from "node:test";
import { verdict } from "../src/check.ts";
import type { Assessment, Pick } from "../src/decision.ts";
import { parseSnapshot, withPage } from "../src/observation.ts";

const pick = (probabilities: Record<string, number>): Pick => ({
  choice: Object.keys(probabilities).sort((a, b) => probabilities[b] - probabilities[a])[0],
  probabilities,
});
const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({
  kind: pick({ value: 1 }),
  negated: pick({ no: 1 }),
  subject: pick({ e1: 1 }),
  area: pick({ page: 1 }),
  state: pick({ disabled: 1 }),
  ...overrides,
});
/** "should not": the same kinds, with Jev's one negation answer. */
const not = { negated: pick({ yes: 1 }) };
const absence = { kind: pick({ presence: 1 }), ...not };
/** A kind as Jev answers it; "absence" is presence, negated. */
const as = (kind: string) => (kind === "absence" ? absence : { kind: pick({ [kind]: 1 }) });

test("Check: plausible kinds must agree, and agreeing kinds carry the pass together", () => {
  const obs = parseSnapshot("- paragraph [ref=e1]: Draft");
  const expected = { values: ["Draft"] };
  assert.equal(verdict(assessment({ kind: pick({ value: 0.55, presence: 0.45 }) }), obs, expected).outcome, "PASSED");
  assert.deepEqual(verdict(assessment({ kind: pick({ value: 0.55, presence: 0.45 }) }), obs, expected).marginal, []);
  // As a value check of the heading it fails, as text on the page it passes.
  const heading = parseSnapshot(`- heading "Campaigns" [ref=e1]\n- paragraph [ref=e2]: Draft`);
  assert.equal(
    verdict(assessment({ kind: pick({ value: 0.55, presence: 0.45 }) }), heading, expected).outcome,
    "AMBIGUOUS",
  );
});

test("Check: a value and a presence check both find the quoted text as whole words (issue #81)", () => {
  const expected = { values: ["Scheduled"] };
  const para = (text: string) => parseSnapshot(`- paragraph [ref=e1]: ${text}`);
  for (const [text, outcome] of [
    ["Scheduled", "PASSED"],
    ["Status: Scheduled", "PASSED"],
    ["scheduled  for May", "PASSED"],
    ["Rescheduled", "ASSERTION_FAILED"], // not a whole word
    ["Draft", "ASSERTION_FAILED"],
    // Known limit: containment cannot tell a negated value; quote the whole value ("Not Scheduled") where it matters.
    ["Not Scheduled", "PASSED"],
  ] as const) {
    assert.equal(verdict(assessment(), para(text), expected).outcome, outcome, text);
    assert.equal(verdict(assessment({ kind: pick({ presence: 1 }) }), para(text), expected).outcome, outcome, text);
  }
  assert.equal(
    verdict(assessment(), para("Draft"), expected).reason,
    `expected "Scheduled", but paragraph shows "Draft"`,
  );
  // Table cells too.
  const rows = parseSnapshot(`- table [ref=t1]:
  - row [ref=r0]:
    - columnheader [ref=c0]: Status
  - row [ref=r1]:
    - cell [ref=c1]: Draft (saved)`);
  assert.equal(verdict(assessment(), rows, { values: [], table: [["Status"], ["Draft"]] }).outcome, "PASSED");
  assert.equal(
    verdict(assessment(), rows, { values: [], table: [["Status"], ["Scheduled"]] }).outcome,
    "ASSERTION_FAILED",
  );
});

test("Check: negation is one answer applied after comparing a text or value; a state names its own", () => {
  const draft = parseSnapshot(`- paragraph [ref=e1]: Draft\n- button "Save" [disabled] [ref=e2]`);
  const value = (v: string) => verdict(assessment(not), draft, { values: [v] });
  assert.deepEqual(
    [value("Draft").outcome, value("Draft").reason],
    ["ASSERTION_FAILED", `expected anything but "Draft", but paragraph shows "Draft"`],
  );
  assert.equal(value("Scheduled").outcome, "PASSED");
  // "should not be disabled" is the state "enabled"; the negation answer is neither applied nor needed.
  const state = (s: string, negated: Pick) =>
    verdict(
      assessment({ negated, kind: pick({ state: 1 }), subject: pick({ e2: 1 }), state: pick({ [s]: 1 }) }),
      draft,
      {
        values: [],
      },
    ).outcome;
  for (const negated of [pick({ no: 1 }), pick({ yes: 1 }), pick({ yes: 0.5, no: 0.5 })]) {
    assert.equal(state("disabled", negated), "PASSED");
    assert.equal(state("enabled", negated), "ASSERTION_FAILED");
  }
  // Unsure whether a value check is negated: nothing to compare against.
  const unsure = verdict(assessment({ negated: pick({ yes: 0.6, no: 0.4 }) }), draft, { values: ["Draft"] });
  assert.deepEqual(
    [unsure.outcome, unsure.reason],
    ["AMBIGUOUS", "Jev is unsure whether the check says it should or should not be so: yes 60%, no 40%"],
  );
  // A subjective check is judged whole: its negation answer is not asked of code.
  const judged = assessment({ kind: pick({ fuzzy: 1 }), negated: pick({ yes: 0.5, no: 0.5 }), judged: 0.9 });
  assert.equal(verdict(judged, draft, { values: [] }).outcome, "JUDGED_PASSED");
});

test("Check: an absence check fails when the text is still shown (refactor bench b-delete)", () => {
  const obs = parseSnapshot(`- table [ref=t1]:
  - row [ref=r1]:
    - cell [ref=c1]: Spring Sale
    - cell [ref=c2]: Draft
- status [ref=s1]: Campaign "Spring Sale" deleted`);
  const a = assessment({ ...absence, area: pick({ t1: 1 }) });
  assert.equal(verdict(a, obs, { values: ["Spring Sale"] }).outcome, "ASSERTION_FAILED");
});

test("Check: negation preserves unknown; a missing subject or area never gives a truth value (issue #81)", () => {
  // The detail screen after a delete that never happened: no campaign list, a toast naming the campaign.
  const detail = parseSnapshot(`- main [ref=m1]:
  - heading "Spring Sale" [level=1] [ref=h1]
  - button "Schedule" [ref=b1]
- status [ref=s1]: Campaign "Spring Sale" saved`);
  const missing = { area: pick({ missing: 1 }) };
  const quoted = { values: ["Spring Sale"] };
  for (const kind of ["presence", "absence"]) {
    const r = verdict(assessment({ ...as(kind), ...missing }), detail, quoted);
    assert.deepEqual([r.outcome, r.reason], ["PENDING", "the area the check names is not on this screen"], kind);
  }
  // Refactor bench: Jev splits the area between the missing list and the page. The page holds the text only in
  // unrelated places; neither that pass nor that failure outvotes the reading that has no evidence.
  const split = { area: pick({ missing: 0.66, page: 0.16, m1: 0.13 }) };
  for (const kind of ["presence", "absence"])
    assert.equal(verdict(assessment({ ...as(kind), ...split }), detail, quoted).outcome, "PENDING", kind);
  // A control or value that is not on the page shows no state and no value: "enabled" is not "not disabled" here.
  const none = { subject: pick({ none: 1 }) };
  for (const state of ["disabled", "enabled"]) {
    const r = verdict(assessment({ kind: pick({ state: 1 }), state: pick({ [state]: 1 }), ...none }), detail, quoted);
    assert.deepEqual([r.outcome, r.reason], ["PENDING", "no element on the page is the control the check is about"]);
  }
  assert.equal(verdict(assessment(none), detail, { values: ["Draft"] }).outcome, "PENDING");
});

test("Check: a negated value: unknown stays unknown; the URL, lists and table rows", () => {
  const not = (snap: string, value: string, more: Partial<Assessment> = {}) =>
    verdict(assessment({ ...absence, kind: pick({ value: 1 }), ...more }), parseSnapshot(snap), { values: [value] });
  assert.equal(not("- paragraph [ref=e1]: Scheduled", "Draft").outcome, "PASSED");
  assert.equal(not("- paragraph [ref=e1]: Status: Draft", "Draft").outcome, "ASSERTION_FAILED");
  // No subject, or one still loading, shows no value: never "not that value".
  assert.equal(not("- paragraph [ref=e1]: Draft", "Draft", { subject: pick({ none: 1 }) }).outcome, "PENDING");
  assert.equal(not(`- region "S" [busy] [ref=r1]:\n  - paragraph [ref=e1]: Saving`, "Draft").outcome, "PENDING");
  // A label is not a value either way.
  assert.equal(not(`- button "Draft" [ref=e1]`, "Draft").outcome, "UNVERIFIABLE");
  // The URL, literally.
  const url = withPage(parseSnapshot(""), "https://x.test/campaigns/2", "T");
  const urlNot = (v: string) =>
    verdict(assessment({ ...absence, kind: pick({ value: 1 }), subject: pick({ url: 1 }) }), url, { values: [v] });
  assert.equal(urlNot("/admin").outcome, "PASSED");
  assert.equal(
    urlNot("/campaigns").reason,
    `expected the URL not to contain "/campaigns", but it is "https://x.test/campaigns/2"`,
  );
  // A list the check says must not be shown: none of its items may be.
  const list = { values: ["Draft"], table: [["Draft"]], list: true };
  const draft = parseSnapshot("- paragraph [ref=e1]: Draft");
  assert.equal(verdict(assessment({ ...absence, kind: pick({ value: 1 }) }), draft, list).outcome, "ASSERTION_FAILED");
  // Negated table rows stay unsupported.
  const rows = { values: [], table: [["Status"], ["Draft"]] };
  assert.equal(verdict(assessment(absence), parseSnapshot(""), rows).outcome, "UNVERIFIABLE");
});

test("Check: an incomplete collection cannot prove absence, a missing row or exact contents; a witness proves presence", () => {
  const list = (marker: string) =>
    parseSnapshot(`- heading "Campaigns" [ref=h1]
- list "Campaigns" [ref=l1]${marker}:
  - listitem [ref=i1]: Autumn Sale
  - progressbar [ref=p1]${marker ? "" : " [busy]"}
- status [ref=s1]: Campaign "Spring Sale" deleted`);
  const inList = (kind: string) => assessment({ ...as(kind), area: pick({ l1: 1 }) });
  const ready = parseSnapshot(`- list "Campaigns" [ref=l1]:
  - listitem [ref=i1]: Autumn Sale`);
  // Complete: the absence holds, a missing text fails.
  assert.equal(verdict(inList("absence"), ready, { values: ["Spring Sale"] }).outcome, "PASSED");
  assert.equal(verdict(inList("presence"), ready, { values: ["Spring Sale"] }).outcome, "ASSERTION_FAILED");
  // Marked as loading, on the list or inside it (an indeterminate progress bar): no witness proves nothing yet.
  for (const marker of [" [busy]", ""]) {
    const loading = list(marker);
    const absent = verdict(inList("absence"), loading, { values: ["Spring Sale"] });
    assert.equal(absent.outcome, "PENDING", marker);
    assert.match(absent.reason!, /^"Spring Sale" is not shown in list "Campaigns".*, but .* is still loading$/);
    assert.equal(verdict(inList("presence"), loading, { values: ["Spring Sale"] }).outcome, "PENDING", marker);
    // A witness is evidence whatever else loads; a shown text contradicts an absence at once.
    assert.equal(verdict(inList("presence"), loading, { values: ["Autumn Sale"] }).outcome, "PASSED", marker);
    assert.equal(verdict(inList("absence"), loading, { values: ["Autumn Sale"] }).outcome, "ASSERTION_FAILED");
  }
  // A busy marker elsewhere does not hold up an area; the page as the area includes it.
  const elsewhere = parseSnapshot(`- list "Campaigns" [ref=l1]:
  - listitem [ref=i1]: Autumn Sale
- region "Feed" [busy] [ref=r1]:
  - paragraph [ref=e1]: x`);
  assert.equal(verdict(inList("absence"), elsewhere, { values: ["Spring Sale"] }).outcome, "PASSED");
  assert.equal(verdict(assessment(absence), elsewhere, { values: ["Spring Sale"] }).outcome, "PENDING");
  // A request in flight: the page may still fill in any area.
  const inFlight = { ...ready, loading: "the page is still loading (a request is in flight)" };
  assert.deepEqual(
    [verdict(inList("absence"), inFlight, { values: ["Spring Sale"] }).reason],
    [`"Spring Sale" is not shown in list "Campaigns", but the page is still loading (a request is in flight)`],
  );
  // A value or state the app marks as still updating is not final either.
  const saving = parseSnapshot(`- region "Status" [busy] [ref=r1]:
  - paragraph [ref=e1]: Draft
  - button "Schedule" [disabled] [ref=b1]`);
  assert.equal(verdict(assessment(), saving, { values: ["Draft"] }).outcome, "PENDING");
  const disabled = assessment({ kind: pick({ state: 1 }), subject: pick({ b1: 1 }) });
  assert.equal(verdict(disabled, saving, { values: [] }).outcome, "PENDING");

  // Table rows: a matched row is a witness; a missing row or "exactly these rows" needs the complete table.
  const rows = (busy: boolean) =>
    parseSnapshot(`- table "Cart" [ref=t1]${busy ? " [busy]" : ""}:
  - row [ref=h1]:
    - columnheader "Product" [ref=c1]
  - row [ref=r1]:
    - cell "Pen" [ref=c2]
  - row [ref=r2]:
    - cell "Ink" [ref=c3]`);
  const table = (want: string[], exact = false) => ({
    values: [],
    table: [["Product"], ...want.map((w) => [w])],
    exact,
  });
  const inTable = assessment({ area: pick({ t1: 1 }) });
  for (const [want, exact, done, loading] of [
    [["Pen"], false, "PASSED", "PASSED"],
    [["Cap"], false, "ASSERTION_FAILED", "PENDING"],
    [["Pen", "Ink"], true, "PASSED", "PENDING"],
    [["Pen", "Ink", "Cap"], true, "ASSERTION_FAILED", "PENDING"],
    [["Ink", "Pen"], true, "ASSERTION_FAILED", "PENDING"],
    [["Pen"], true, "ASSERTION_FAILED", "ASSERTION_FAILED"], // "Ink" is a row no expected one matches
  ] as const) {
    const label = `${want} exact=${exact}`;
    assert.equal(verdict(inTable, rows(false), table([...want], exact)).outcome, done, label);
    assert.equal(verdict(inTable, rows(true), table([...want], exact)).outcome, loading, label);
  }
});

test("Check: every plausible reading counts; one without evidence is not outvoted by one that passed", () => {
  const obs = parseSnapshot(`- paragraph [ref=e1]: Draft
- region "Feed" [busy] [ref=r1]:
  - paragraph [ref=e2]: x`);
  // As a value check it passes; as a presence check of an area not on the screen it is not known yet.
  const r = verdict(assessment({ kind: pick({ value: 0.6, presence: 0.4 }), area: pick({ missing: 1 }) }), obs, {
    values: ["Draft"],
  });
  assert.deepEqual([r.outcome, r.reason], ["PENDING", "the area the check names is not on this screen"]);
  const pending = verdict(assessment({ kind: pick({ presence: 0.6, value: 0.4 }), subject: pick({ none: 1 }) }), obs, {
    values: ["Draft"],
  });
  assert.deepEqual(
    [pending.outcome, pending.reason],
    ["PENDING", "no element on the page shows what the check describes"],
  );
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
    assert.equal(verdict(assessment({ ...as(kind), area }), obs, expected).outcome, "AMBIGUOUS");
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
  assert.equal(verdict(assessment({ ...absence, area: pick({ a1: 1 }) }), obs, expected).outcome, "UNVERIFIABLE");
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
    "UNVERIFIABLE", // read as a value check it cannot be compared, and the presence pass does not outvote that
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
  assert.deepEqual(fuzzy(0.9).details, ["  Kind: fuzzy=1.00  Negated: no=1.00", "  Judged: p=0.90"]);

  const snap = `- region "R" [ref=a1]:\n  - paragraph [ref=e1]: Apple Pear\n- paragraph [ref=e2]: Plum`;
  const presence = { kind: pick({ presence: 1 }) };
  assert.deepEqual(reading(run(snap, presence, [])), {
    outcome: "UNVERIFIABLE",
    reason: 'the check quotes no text to look for (e.g. "Winter Sale" should appear)',
  });
  assert.deepEqual(reading(run(snap, presence, ["Kiwi", "Apple"])), {
    outcome: "ASSERTION_FAILED",
    reason: '"Kiwi" and "Apple" is not shown in the page',
  });
  // Text nowhere on the page still needs the area's answer: it decides whether the evidence is complete.
  assert.deepEqual(run(snap, presence, ["Kiwi"]).details, [
    "  Kind: presence=1.00  Negated: no=1.00",
    "  Area: page=1.00",
  ]);
  assert.deepEqual(reading(run(snap, { ...presence, area: pick({ a1: 1 }) }, ["Apple", "Pear"])), {
    outcome: "PASSED",
    reason: undefined,
  });
  assert.deepEqual(run(snap, { ...presence, area: pick({ a1: 1 }) }, ["Apple"]).details, [
    "  Kind: presence=1.00  Negated: no=1.00",
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
    outcome: "PENDING",
    reason: "the area the check names is not on this screen",
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
  const both = run(snap, { ...presence, area: pick({ a1: 0.5, page: 0.5 }) }, ["Kiwi"]);
  assert.equal(both.reason, `"Kiwi" is not shown in the page`);
  // a failing area does not outvote one not on the screen
  const missing = run(snap, { ...presence, area: pick({ a1: 0.5, missing: 0.5 }) }, ["Plum"]);
  assert.deepEqual(reading(missing), { outcome: "PENDING", reason: "the area the check names is not on this screen" });
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
    outcome: "PENDING",
    reason: "no element on the page is the control the check is about",
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
    "  Kind: value=1.00  Negated: no=1.00",
    "  Subject: e1=1.00",
    `  Compare: "Draft" in "Draft"`,
  ]);
  assert.deepEqual(reading(value("e2", ["Go"])), {
    outcome: "UNVERIFIABLE",
    reason: `button "Go" has no text to compare (only a label)`,
  });
  assert.deepEqual(reading(value("none", ["Go"])), {
    outcome: "PENDING",
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
  assert.deepEqual(reading(value("e7", ["done"])), {
    outcome: "ASSERTION_FAILED",
    reason: `expected "done", but link shows "Not"`,
  });
  assert.equal(value("e1", ["Dra"]).outcome, "ASSERTION_FAILED");
  assert.deepEqual(reading(run(`- paragraph [ref=e1]: Draft saved`, {}, ["Final"])), {
    outcome: "ASSERTION_FAILED",
    reason: `expected "Final", but paragraph shows "Draft saved"`,
  });
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

test("Check: a kind reading that cannot decide is not outvoted by one that passed (issue #81)", () => {
  // GitHub `"screenshot" should appear in the issue list`: presence 79% passed, value 21% could not pick a subject
  // (the link shows it, the heading does not). That reading is plausible, so the check is AMBIGUOUS (it used to pass
  // as marginal).
  const snap = `- heading "Issues" [ref=e4]\n- list "Issues" [ref=e1]:\n  - link "Fix screenshot timeout" [ref=e2]\n  - link "Add screenshot option" [ref=e3]`;
  const a = {
    kind: pick({ presence: 0.79, value: 0.21 }),
    area: pick({ e1: 1 }),
    subject: pick({ e2: 0.5, e4: 0.5 }),
  };
  const r = run(snap, a, ["screenshot"]);
  assert.equal(r.outcome, "AMBIGUOUS");
  assert.match(r.reason!, /^Jev is unsure which element the check is about/);
  // A confident kind leaves the other reading out: presence alone passes.
  assert.equal(run(snap, { ...a, kind: pick({ presence: 0.9, value: 0.1 }) }, ["screenshot"]).outcome, "PASSED");
  // Unsure whether it is negated: AMBIGUOUS.
  assert.equal(
    run(snap, { ...a, kind: pick({ presence: 1 }), negated: pick({ no: 0.6, yes: 0.4 }) }, ["screenshot"]).outcome,
    "AMBIGUOUS",
  );
  // Nothing decided at all stays AMBIGUOUS.
  assert.equal(run(snap, { ...a, kind: pick({ value: 1 }) }, ["screenshot"]).outcome, "AMBIGUOUS");
});

test("Check reasons: kinds disagree, none applies, table shapes", () => {
  const snap = `- paragraph [ref=e1]: Draft`;
  assert.deepEqual(reading(run(snap, { kind: pick({ value: 0.5, state: 0.5 }) }, ["Draft"])), {
    outcome: "AMBIGUOUS",
    reason:
      'Jev could not tell what kind of check this is, and the readings disagree: as a value check it is PASSED; as a state check it is ASSERTION_FAILED (expected paragraph value="Draft" to be disabled, but it is not)',
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
  assert.deepEqual(reading(run(snap, absence, { values: [], table: [["a"], ["b"]] })), {
    outcome: "UNVERIFIABLE",
    reason: "a check that table rows are not shown is not supported; check each row's absence in its own Step",
  });
  // a list (one column, no header) is a presence check per item, or absence
  const list = { values: ["Draft"], table: [["Draft"]], list: true };
  assert.equal(run(snap, { kind: pick({ value: 1 }) }, list).outcome, "PASSED");
  assert.equal(run(snap, absence, list).outcome, "ASSERTION_FAILED");
  assert.deepEqual(run(snap, { kind: pick({ value: 0.6, state: 0.4 }) }, list).marginal, []);
  assert.equal(run(snap, { negated: pick({ no: 0.5, yes: 0.5 }) }, list).outcome, "AMBIGUOUS");
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
    outcome: "PENDING",
    reason: "the table the check names is not on this screen",
  });
  assert.deepEqual(rows([["Product"], ["Cap"]], { gone: 1 }), {
    outcome: "ELEMENT_NOT_FOUND",
    reason: "Jev chose an area that is no longer on the page (gone)",
  });
  assert.equal(rows([["Product"], ["Cap"]], { t1: 0.5, t2: 0.5 }).outcome, "AMBIGUOUS");
  assert.deepEqual(run(grid, {}, { values: [], table: [["Product"], ["Cap"]] }).details, [
    "  Kind: value=1.00  Negated: no=1.00",
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

test("Check: a subject that only wraps the one read (a button around its text) is the same answer, not a split", () => {
  const obs = parseSnapshot('- button "Model" [ref=e1] [cursor=pointer]:\n  - generic [ref=e2]: mock-model');
  const split = assessment({ subject: pick({ e1: 0.5, e2: 0.45 }) });
  const pass = verdict(split, obs, { values: ["mock-model"] });
  assert.equal(pass.outcome, "PASSED");
  assert.deepEqual(pass.marginal, []);
  assert.equal(verdict(split, obs, { values: ["gpt-4"] }).outcome, "ASSERTION_FAILED");
  // The button shows more than that text: a real split between two answers, still marginal.
  const more = parseSnapshot(
    '- button "Model" [ref=e1]:\n  - generic [ref=e2]: mock-model\n  - generic [ref=e3]: beta',
  );
  assert.notDeepEqual(verdict(split, more, { values: ["mock-model"] }).marginal, []);
});
