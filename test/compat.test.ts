// Cassettes recorded by a released version replay unchanged in every later one (issue #90): with no Jev call, each
// Step reports what that release reported. In 0.5.0 every fixture cassette was re-recorded together with the change,
// so the suite compared the new version with itself; these files are never re-recorded.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { promisify } from "node:util";

for (const release of readdirSync("test/fixtures/compat")) {
  test(`cassettes recorded by ${release} replay with the same outcomes and no Jev call`, async () => {
    const root = `test/fixtures/compat/${release}`;
    const features = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".feature"))
      .map((f) => `${root}/${f}`);
    const out = await promisify(execFile)(
      "node",
      ["src/cli.ts", "run", ...features, "--record", "none", "--no-agent-report", "--parallel", "auto"],
      { env: { ...process.env, TYPESAFE_API_KEY: "", OPENROUTER_API_KEY: "", DECISIUM_MODEL_API_KEY: undefined } },
    ).then(
      (o) => o.stdout,
      (e: { stdout: string }) => e.stdout, // the cookbook's "Should FAIL" scenarios fail on purpose
    );
    const run = /Run directory: (\S+)/.exec(out)![1];
    const steps = readFileSync(`${run}/trace.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "step");
    assert.equal(
      steps.reduce((n, s) => n + s.jevCalls, 0),
      0,
    );
    const outcomes = Object.fromEntries(steps.map((s) => [s.at, s.outcome]).sort());
    assert.deepEqual(outcomes, JSON.parse(readFileSync(`test/fixtures/compat/${release}/outcomes.json`, "utf8")));
  });
}
