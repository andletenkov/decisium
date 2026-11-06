import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { SavedStorage } from "../src/saved.ts";

const F = "test/fixtures/states";

test("@state: and @save:storage through decisium run: saved once per run, loaded into later consumers, chains replay their tail (issue 11)", async () => {
  const server = createServer((_, res) => res.end("<!doctype html><title>shop</title><h1>Shop</h1>"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const log = join(mkdtempSync(join(tmpdir(), "decisium-states-")), "log.txt");
  const run = (...files: string[]) =>
    promisify(execFile)(
      "node",
      [
        "src/cli.ts",
        "run",
        ...files,
        "--url",
        url,
        "--import",
        `${F}/states.steps.ts`,
        "--record",
        "none",
        "--no-agent-report",
      ],
      { env: { ...process.env, TYPESAFE_API_KEY: "", STATES_LOG: log } },
    ).then(
      (o) => ({ ...o, code: 0 }),
      (e: { stdout: string; stderr: string; code: number }) => e,
    );
  try {
    const ok = await run(`${F}/states.feature`, `${F}/shop.state.feature`); // a named definition file is skipped
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    // First consumer: log in + check, then saves. Second: loads, re-runs the check. Third: loads, checks, adds the item.
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "log in",
      "check",
      "check",
      "check",
      "add an item",
    ]);
    const dir = /Run directory: (\S+)/.exec(ok.stdout)![1];
    assert.equal(existsSync(new SavedStorage(dir).dir), false); // run-scoped: removed at the end
    assert.match(readFileSync(join(dir, "log.txt"), "utf8"), /state logged-in: loaded saved storage/);

    // A failing state is a setup error (exit 2) for its consumer; the other scenarios still run and pass.
    writeFileSync(log, "");
    const broken = await run(`${F}/broken.feature`, `${F}/states.feature`);
    assert.equal(broken.code, 2);
    assert.match(broken.stdout, /in state "broken" at test\/fixtures\/states\/shop.state.feature:15: not logged in/);
    assert.match(broken.stdout, /3\/4 scenarios passed/);

    // The saved session is revoked: the next consumer's check after loading fails, so it logs in again and passes.
    writeFileSync(log, "");
    const expired = await run(`${F}/expire.feature`);
    assert.equal(expired.code, 0, expired.stdout + expired.stderr);
    assert.deepEqual(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => l.replace(/^revoke .*/, "revoke")),
      ["log in", "check", "revoke", "check", "log in", "check"],
    );
    const edir = /Run directory: (\S+)/.exec(expired.stdout)![1];
    assert.match(readFileSync(join(edir, "log.txt"), "utf8"), /check failed after loading; replaying its Steps/);

    const only = await run(`${F}/shop.state.feature`);
    assert.equal(only.code, 2);
    assert.match(only.stderr, /Only state definition files given/);
  } finally {
    server.close();
  }
});

test("decisium run: state mistakes, @state-def in a test included, stop before any browser opens", async () => {
  const run = (env: Record<string, string>, ...files: string[]) =>
    promisify(execFile)(
      "node",
      [
        "src/cli.ts",
        "run",
        ...files,
        "--url",
        "http://127.0.0.1:9/",
        "--import",
        `${F}/states.steps.ts`,
        "--record",
        "none",
        "--no-agent-report",
      ],
      { env: { ...process.env, TYPESAFE_API_KEY: "", STATES_LOG: "/dev/null", ...env } },
    ).then(
      (o) => ({ ...o, code: 0 }),
      (e: { stdout: string; stderr: string; code: number }) => e,
    );
  const N = `${F}/negative`;
  const fails = async (file: string, re: RegExp, env: Record<string, string> = {}) => {
    const r = await run(env, file);
    assert.equal(r.code, 2, `${file}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re);
    assert.doesNotMatch(r.stdout, /Run directory/); // nothing ran
  };
  await fails(`${N}/unknown.feature`, /unknown state "nope"/);
  await fails(`${N}/typo.feature`, /@stat:logged-in: unknown tag, did you mean @state:\?/);
  await fails(`${N}/url.feature`, /@url: and @state: together/);
  // A broken definition anywhere in the discovered files stops the run, naming its file and line.
  const dir = mkdtempSync(join(tmpdir(), "decisium-bad-"));
  writeFileSync(
    join(dir, "bad.state.feature"),
    "Feature: f\n  @state-def:no-check @save:storage\n  Scenario: s\n    When I log in\n",
  );
  await fails(`${F}/states.feature`, /bad.state.feature:3: @save:storage state "no-check" must end with a Then/, {
    DECISIUM_STATES: `${dir}/*.state.feature`,
  });
  writeFileSync(
    join(dir, "bad.state.feature"),
    "Feature: f\n  @state-def:a @state:b\n  Scenario: s\n    When I log in\n  @state-def:b @state:a\n  Scenario: t\n    When I log in\n",
  );
  await fails(`${F}/states.feature`, /state cycle/, { DECISIUM_STATES: `${dir}/*.state.feature` });

  await fails(`${N}/def-in-test.feature`, /@state-def: only works in a \*\.state\.feature file/);
});

test("raw cucumber-js: a state definition file among the test paths fails clearly", async () => {
  const r = await promisify(execFile)("npx", ["cucumber-js", `${F}/shop.state.feature`], {
    env: { ...process.env, TYPESAFE_API_KEY: "", DECISIUM_RECORD: "none", DECISIUM_NO_AGENT_REPORT: "1" },
  }).then(
    (o) => ({ ...o, code: 0 }),
    (e: { stdout: string; code: number }) => e,
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /shop.state.feature is a state definition file; exclude it from test paths/);
});
