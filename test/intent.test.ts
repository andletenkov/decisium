import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Cassette } from "../src/cassette.ts";
import type { Decider } from "../src/decision.ts";

const path = () => `${mkdtempSync(`${tmpdir()}/intent-`)}/t.cassette.json`;
const live = (calls: { n: number }) =>
  ({
    intent: async () => {
      calls.n++;
      return { attempt: true };
    },
  }) as unknown as Decider;

test("cassette: an intent is recorded once and replayed with no Jev call (issue #31)", async () => {
  const p = path(),
    calls = { n: 0 };
  const rec = new Cassette(p, "m", "new");
  const d = rec.step("S: I submit the empty form", live(calls));
  assert.deepEqual(await d.intent!("I submit the empty form", false), { attempt: true });
  d.done(true);
  rec.save();
  const play = new Cassette(p, "m", "none").step("S: I submit the empty form", live(calls));
  assert.deepEqual(await play.intent!("I submit the empty form", false), { attempt: true });
  assert.equal(calls.n, 1);
});

test("cassette: an entry recorded before intents replays with the wording rules alone", async () => {
  const p = path(),
    calls = { n: 0 };
  writeFileSync(p, JSON.stringify({ model: "m", entries: { "S: I go back": { turns: [] } } }));
  for (const mode of ["none", "new"] as const) {
    const d = new Cassette(p, "m", mode).step("S: I go back", live(calls));
    assert.deepEqual(await d.intent!("I go back", false), {});
  }
  assert.equal(calls.n, 0);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).entries["S: I go back"].intent, undefined);
});
