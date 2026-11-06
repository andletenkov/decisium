import assert from "node:assert/strict";
import { test } from "node:test";
import { fill, newRunId } from "../src/generate.ts";

test("runId is substituted everywhere, without interpreting other text", () => {
  assert.equal(
    fill("Agent {{decisium.runId}} and {{decisium.runId}} {{runId}}", { "{{decisium.runId}}": "abc" }),
    "Agent abc and abc {{runId}}",
  );
  assert.equal(fill("Agent {{decisium.runId}}", {}), "Agent {{decisium.runId}}");
});

test("run ID fits the documented name within 40 characters", () => {
  const id = newRunId();
  assert.match(id, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(`Autotest agent ${id}`.length <= 40);
  assert.notEqual(id, newRunId());
});
