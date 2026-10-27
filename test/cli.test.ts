import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const commands = ["run", "step", "lint", "doctor"];
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function invoke(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "decisium-cli-"));
  try {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, TYPESAFE_API_KEY: "", DECISIUM_DEBUG: "" },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("cli: bare invocation keeps usage and exit 2", () => {
  const result = invoke([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^Usage:\n/);
  assert.equal(result.stdout, "");
});

for (const args of [["bogus"], ["help", "bogus"], ["bogus", "--help"]]) {
  test(`cli: ${args.join(" ")} reports unknown command`, () => {
    const result = invoke(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^Error: unknown command: bogus\n\nUsage:/);
    assert.equal(result.stdout, "");
  });
}

for (const command of ["", ...commands]) {
  test(`cli: unknown flag shows ${command || "top-level"} help`, () => {
    const result = invoke([...(command ? [command] : []), "--nope"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^Error: Unknown option '--nope'\n\nUsage:/);
    if (command) assert.ok(result.stderr.includes(`Usage:\n  decisium ${command}`));
    assert.ok(!result.stderr.includes("positional argument"));
    assert.equal(result.stdout, "");
  });
}

test("cli: invalid option value shows command help with leading options", () => {
  const result = invoke(["--url", "x", "run", "--headed=yes"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^Error: Option '--headed' does not take an argument\n\nUsage:\n {2}decisium run/);
  assert.ok(!result.stderr.includes("decisium step"));
  assert.equal(result.stdout, "");
});

test("cli: -v remains verbose, not version", () => {
  const result = invoke(["-v"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^Usage:/);
  assert.equal(result.stdout, "");
});

for (const flag of ["--help", "-h"]) {
  test(`cli: ${flag} prints top-level help`, () => {
    const result = invoke([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage:\n/);
    for (const command of commands) assert.ok(result.stdout.includes(`decisium ${command}`));
    assert.ok(!result.stdout.includes("cassette.json"));
    assert.equal(result.stderr, "");
  });
}

for (const command of commands) {
  for (const args of [
    [command, "-h"],
    [command, "--help"],
    ["help", command],
  ]) {
    test(`cli: ${args.join(" ")} prints only command help`, () => {
      const result = invoke(args);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.startsWith(`Usage:\n  decisium ${command}`));
      for (const other of commands.filter((name) => name !== command)) {
        assert.ok(!result.stdout.includes(`decisium ${other}`));
      }
      const details: Record<string, string[]> = {
        run: [
          "--url",
          "--record",
          "--parallel",
          "--format",
          "--import",
          "-p",
          "--no-agent-report",
          "cassette.json",
          "cucumber",
        ],
        step: ["--url", "--headed", "--judged", "--strict"],
        lint: ["no browser", "no Jev"],
        doctor: ["Node", "Chromium", "TYPESAFE_API_KEY"],
      };
      for (const detail of details[command]) assert.ok(result.stdout.includes(detail), detail);
      assert.equal(result.stderr, "");
    });
  }
}

for (const flag of ["--version", "-V"]) {
  test(`cli: ${flag} prints installed version outside package directory`, () => {
    const result = invoke([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, "");
  });
}
