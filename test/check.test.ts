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
