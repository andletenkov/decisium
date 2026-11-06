import assert from "node:assert/strict";
import { test } from "node:test";
import { fill } from "../src/generate.ts";

test("runId is substituted everywhere, without interpreting other text", () => {
  assert.equal(fill("Agent {{runId}} and {{runId}} {{date}}", { "{{runId}}": "abc" }), "Agent abc and abc {{date}}");
  assert.equal(fill("Agent {{runId}}", {}), "Agent {{runId}}");
});
