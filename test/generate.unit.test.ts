import assert from "node:assert/strict";
import { test } from "node:test";
import { fill, Generated, templates } from "../src/generate.ts";
import { placeholder } from "../src/step.ts";

const start = new Date(2025, 0, 31, 23, 4, 5).getTime();
const gen = (seed = "s1") => new Generated(seed, start);
const one = (t: string, g = gen()) => g.values([t])[t];

test("templates: {{fn[:label] [args]}} anywhere in the text", () => {
  assert.deepEqual(templates("Agent {{unique:a}}, {{ text 5 }} and {{date +1d DD.MM.YYYY}}"), [
    "{{unique:a}}",
    "{{ text 5 }}",
    "{{date +1d DD.MM.YYYY}}",
  ]);
  assert.deepEqual(templates("$USER {x} plain"), []);
  assert.equal(placeholder("$USER"), "USER"); // secrets are untouched
});

test("each function has its format", () => {
  assert.match(one("{{unique}}"), /^[\da-z]{10,14}$/);
  assert.match(one("{{uuid}}"), /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  const n = Number(one("{{number}}"));
  assert.ok(n >= 100000 && n <= 999999);
  assert.ok(["1", "2", "3"].includes(one("{{number 1 3}}")));
  assert.equal(one("{{date}}"), "2025-01-31");
  assert.equal(one("{{datetime}}"), "2025-01-31T23:04");
  assert.equal(one("{{date +1d}}"), "2025-02-01");
  assert.equal(one("{{date -1M DD.MM.YYYY}}"), "31.12.2024");
  assert.equal(one("{{datetime +2h YYYY-MM-DD HH:mm:ss}}"), "2025-02-01 01:04:05");
  assert.equal(one("{{timestamp}}"), String(start));
  assert.equal(one("{{text 4}}"), "aaaa");
  assert.equal(one("{{text 3 x}}"), "xxx");
  assert.match(one("{{email}}"), /^autotest\+[\da-z]+@example\.com$/);
});

test("one value per function, label and args for the run; the seed repeats random values", () => {
  const g = gen();
  const v = g.values(["A {{unique:a}} {{unique:b}} {{uuid:a}}", "{{ unique:a }}"]);
  assert.notEqual(v["{{unique:a}}"], v["{{unique:b}}"]);
  assert.equal(v["{{ unique:a }}"], v["{{unique:a}}"]);
  assert.equal(one("{{uuid:a}}", gen()), v["{{uuid:a}}"]); // same seed: same value, in another worker too
  assert.notEqual(one("{{uuid:a}}", gen("s2")), v["{{uuid:a}}"]);
  assert.equal(fill("Agent {{unique:a}} ($USER)", v), `Agent ${v["{{unique:a}}"]} ($USER)`);
});

test("an unknown function or bad args is an error naming the template", () => {
  for (const t of [
    "{{uuidd}}",
    "{{UUID}}",
    "{{uuid:bad-name}}",
    "{{}}",
    "{{text abc}}",
    "{{text}}",
    "{{text 999999999999999999999}}",
    "{{number 5 1}}",
    "{{date +3x}}",
    "{{date rubbish}}",
    "{{uuid 1}}",
  ])
    assert.throws(() => gen().values([t]), new RegExp(t.replace(/[{}+]/g, "\\$&")));
});
