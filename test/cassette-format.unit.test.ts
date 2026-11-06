import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Cassette } from "../src/cassette.ts";
import type { Decider } from "../src/decision.ts";

test("cassette entries stay compact across recording and legacy replay", async () => {
  const path = `${mkdtempSync(`${tmpdir()}/cassette-`)}/test.cassette.json`;
  const key = 'Scenario: "first"\nstep';
  let calls = 0;
  const live = {
    recall: async () => {
      calls++;
      return { choice: "answer", probabilities: { answer: 1 } };
    },
  } as unknown as Decider;
  const record = new Cassette(path, "model", "new");
  const first = record.step(key, live);
  await first.recall("step", { answer: "value" });
  first.done(true);
  record.save();
  const compact = readFileSync(path, "utf8");
  const file = JSON.parse(compact);
  assert.ok(compact.split("\n").some((line) => line.includes(JSON.stringify(key)) && line.includes('"recall"')));
  const replay = new Cassette(path, "model", "none").step(key, live);
  assert.equal((await replay.recall("step", { answer: "value" })).choice, "answer");
  assert.equal(replay.done(true), "replayed");
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), file);

  writeFileSync(path, JSON.stringify(file, null, 2));
  const old = new Cassette(path, "model", "new");
  const oldStep = old.step(key, live);
  assert.equal((await oldStep.recall("step", { answer: "value" })).choice, "answer");
  assert.equal(oldStep.done(true), "replayed");
  const added = old.step("Scenario: second", live);
  await added.recall("step", { answer: "value" });
  added.done(true);
  old.save();
  const rewritten = readFileSync(path, "utf8");
  assert.deepEqual(JSON.parse(rewritten).entries[key], file.entries[key]);
  assert.equal(
    rewritten.split("\n").filter((line) => line.includes('"recall"') && line.includes('"Scenario:')).length,
    2,
  );
  assert.equal(calls, 2);
});
