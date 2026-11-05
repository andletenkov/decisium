import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const commands = ["run", "step", "lint", "doctor", "install", "pin"];
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

test("cli: TypeScript client steps resolve extensionless imports in serial and parallel", () => {
  const cwd = mkdtempSync(join(tmpdir(), "decisium-ts-"));
  try {
    writeFileSync(join(cwd, "helpers.ts"), 'export const value: string = "loaded";');
    writeFileSync(
      join(cwd, "steps.ts"),
      `import { Given } from ${JSON.stringify(createRequire(import.meta.url).resolve("@cucumber/cucumber"))};\nimport { value } from "./helpers";\nGiven("a client step", function () { if (value !== "loaded" || !this.page) throw new Error("wrong helper or world"); });\n`,
    );
    writeFileSync(
      join(cwd, "hooks.ts"),
      `import { Before, World, setWorldConstructor } from ${JSON.stringify(createRequire(import.meta.url).resolve("@cucumber/cucumber"))};\nsetWorldConstructor(class extends World {});\nBefore(function () { if (this.browser) throw new Error("client hook ran after Decisium setup"); });\n`,
    );
    writeFileSync(join(cwd, "page.html"), "<html><body>ready</body></html>");
    for (const name of ["one", "two"])
      writeFileSync(join(cwd, `${name}.feature`), `Feature: ${name}\n  Scenario: test\n    Given a client step\n`);
    const noImports = spawnSync(
      process.execPath,
      [cli, "run", "one.feature", "--url", join(cwd, "page.html"), "--record", "none"],
      {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 10_000_000,
        env: { ...process.env, TYPESAFE_API_KEY: "", NODE_OPTIONS: "", NODE_DEBUG: "esm" },
      },
    );
    assert.equal(noImports.status, 1, noImports.error?.message ?? noImports.stdout);
    assert.doesNotMatch(noImports.stderr, /Translating (?:StandardModule|TypeScript) file:.*\/src\/ts-loader\.ts/);
    for (const parallel of [false, true]) {
      for (const configured of [false, true]) {
        writeFileSync(join(cwd, "package.json"), JSON.stringify({ type: configured ? "commonjs" : "module" }));
        if (configured)
          writeFileSync(join(cwd, "cucumber.mjs"), 'export default { import: ["hooks.ts", "steps.ts"] };');
        const result = spawnSync(
          process.execPath,
          [
            cli,
            "run",
            "one.feature",
            ...(parallel ? ["two.feature", "--parallel", "2"] : []),
            ...(configured ? [] : ["--import", "steps.ts"]),
            "--url",
            join(cwd, "page.html"),
            "--record",
            "none",
          ],
          { cwd, encoding: "utf8", timeout: 30_000, env: { ...process.env, TYPESAFE_API_KEY: "", NODE_OPTIONS: "" } },
        );
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, parallel ? /2\/2 scenarios passed/ : /1\/1 scenarios passed/);
        if (configured) rmSync(join(cwd, "cucumber.mjs"));
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
        pin: ["candidate", "pinned", "--record none"],
        lint: ["no browser", "no Jev"],
        doctor: ["Node", "Chromium", "TYPESAFE_API_KEY"],
        install: ["Chromium", "--with-deps"],
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

test("cli: install fetches the Chromium Decisium launches (its own Playwright, not npx's)", async () => {
  const { chromium } = await import("playwright");
  const result = invoke(["install", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  // e.g. .../ms-playwright/chromium-1248/chrome-mac-arm64/... -> the chromium-1248 directory
  const dir = /^(.*[\\/]chromium-\d+)/.exec(chromium.executablePath())![1];
  assert.ok(result.stdout.includes(dir), `${dir} not in:\n${result.stdout}`);
});
