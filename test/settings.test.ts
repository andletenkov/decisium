import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Cassette } from "../src/cassette.ts";
import { verdict } from "../src/check.ts";
import { Browser } from "../src/browser.ts";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { confidence, gate, type Decider, type Pick } from "../src/decision.ts";
import { parseSnapshot } from "../src/observation.ts";
import { applyOptions, settings, settingWarnings } from "../src/options.ts";
import { runAssertion, runStep, type Runtime } from "../src/runner.ts";
import { RunDir } from "../src/trace.ts";

test("settings: plausible readings honor higher answer confidence", async () => {
  const obs = parseSnapshot("- paragraph [ref=e1]: Done\n- paragraph [ref=e2]: Pending");
  const a = {
    kind: sure("value"),
    state: sure("disabled"),
    area: sure("page"),
    subject: { choice: "e1", probabilities: { e1: 0.84, e2: 0.16 } },
  };
  await withEnv({ CONFIDENCE_ANSWER: "0.95" }, async () => {
    assert.equal(verdict(a, obs, { values: ["Done"] }).outcome, "AMBIGUOUS");
  });
});

test("settings: replay retains recorded confidence and failed outcomes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decisium-replay-"));
  const rt: Runtime = {
    actionStep: (run) => run(),
    execute: async () => {},
    waitForChange: async () => false,
    observe: async () => parseSnapshot('- button "Save" [disabled] [ref=e1]', new Set(["e1"])),
  };
  const live: Decider = {
    ...base,
    assess: async () => ({
      kind: sure("state"),
      subject: sure("e1"),
      area: sure("page"),
      state: { choice: "disabled", probabilities: { disabled: 0.7, enabled: 0.3 } },
    }),
  };
  try {
    for (const answer of ["0.6", "0.9"]) {
      const path = join(dir, `${answer}.json`);
      const original = await withEnv({ CONFIDENCE_ANSWER: answer }, async () => {
        const c = new Cassette(path, "test", "all");
        const d = c.step("check", live);
        const result = await runAssertion("Save should be disabled", rt, d, () => {});
        d.done(true);
        c.save();
        return result;
      });
      await withEnv({ CONFIDENCE_ANSWER: answer === "0.6" ? "0.99" : "0.1" }, async () => {
        const d = new Cassette(path, "test", "none").step("check", base);
        assert.deepEqual(await runAssertion("Save should be disabled", rt, d, () => {}), original);
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings: replay keeps target and margin gates, including legacy cassettes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decisium-target-"));
  const obs = parseSnapshot('- button "Save" [ref=e1]\n- button "Cancel" [ref=e2]', new Set(["e1", "e2"]));
  try {
    const path = join(dir, "cassette.json");
    await withEnv({ CONFIDENCE_TARGET: "0.5", CONFIDENCE_ANSWER: "0.4" }, async () => {
      const c = new Cassette(path, "test", "all");
      const d = c.step("target", {
        ...base,
        turn: async () => ({ done: 0, target: { choice: "e1", probabilities: { e1: 0.54, e2: 0.46 } } }),
      });
      await d.turn("Save", obs, []);
      d.done(true);
      c.save();
    });
    await withEnv({ CONFIDENCE_TARGET: "0.99" }, async () => {
      const { target } = await new Cassette(path, "test", "none").step("target", base).turn("Save", obs, []);
      assert.equal(confidence(target).target, 0.5);
      assert.equal(gate(target, confidence(target).target, 0.1), false, "runner-up must survive recording");
    });
    const file = JSON.parse(readFileSync(path, "utf8"));
    delete file.entries.target.confidence;
    writeFileSync(path, JSON.stringify(file));
    await withEnv({ CONFIDENCE_TARGET: "0.99" }, async () => {
      const { target } = await new Cassette(path, "test", "none").step("target", base).turn("Save", obs, []);
      assert.deepEqual(confidence(target), { target: 0.5, answer: 0.8 });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings: healing preserves confidence on replayed prefix and live suffix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decisium-heal-"));
  const path = join(dir, "cassette.json");
  const obs = parseSnapshot('- button "Save" [ref=e1]', new Set(["e1"]));
  const live: Decider = {
    ...base,
    turn: async () => ({ done: 0, target: { choice: "e1", probabilities: { e1: 0.7, none: 0.3 } } }),
  };
  try {
    await withEnv({ CONFIDENCE_TARGET: "0.5" }, async () => {
      const c = new Cassette(path, "test", "all");
      const d = c.step("flow", live);
      await d.turn("Save", obs, []);
      d.done(true);
      c.save();
    });
    await withEnv({ CONFIDENCE_TARGET: "0.99" }, async () => {
      const c = new Cassette(path, "test", "new");
      const d = c.step("flow", live);
      const prefix = await d.turn("Save", obs, []);
      assert.equal(confidence(prefix.target).target, 0.5);
      await d.turn("Save", obs, ["CLICK"]); // no recorded second Turn: heal live
      assert.equal(d.done(true), "healed");
      c.save();
    });
    await withEnv({ CONFIDENCE_TARGET: "0.1" }, async () => {
      const d = new Cassette(path, "test", "none").step("flow", base);
      const prefix = await d.turn("Save", obs, []);
      const suffix = await d.turn("Save", obs, ["CLICK"]);
      assert.equal(confidence(prefix.target).target, 0.5);
      assert.equal(confidence(suffix.target).target, 0.99);
      assert.equal(gate(prefix.target, confidence(prefix.target).target, 0.1), true);
      assert.equal(gate(suffix.target, confidence(suffix.target).target, 0.1), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings: actionTimeout bounds a busy page", async () => {
  await withEnv({ ACTION_TIMEOUT: "150" }, async () => {
    const b = await Browser.open("data:text/html,<p>Busy</p>");
    try {
      await b.page.evaluate(() => {
        setInterval(() => {
          document.body.textContent = String(Date.now());
        }, 10);
      });
      const start = Date.now();
      await b.execute({ verb: "WAIT" });
      assert.ok(Date.now() - start < 2000, "WAIT must use actionTimeout, not the default 5s");
    } finally {
      await b.close();
    }
  });
});

test("settings: CLI precedence and raw parallel reports carry effective settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "decisium-config-"));
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const cucumber = fileURLToPath(new URL("../node_modules/@cucumber/cucumber/bin/cucumber.js", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DECISIUM_")));
  try {
    writeFileSync(join(dir, "page.html"), "<button>Save</button>");
    for (const n of [1, 2])
      writeFileSync(join(dir, `${n}.feature`), `Feature: ${n}\nScenario: ${n}\nWhen I click Save\n`);
    writeFileSync(
      join(dir, "cucumber.mjs"),
      `export default ${JSON.stringify({
        import: [join(src, "steps.ts")],
        format: [join(src, "formatter.ts")],
        worldParameters: {
          decisium: {
            url: join(dir, "page.html"),
            record: "none",
            reportDir: "artifacts",
            confidence: { answer: 0.5 },
            maxTurns: 12,
          },
        },
      })}`,
    );
    const invoke = (args: string[], extra = {}) =>
      spawnSync(process.execPath, args, {
        cwd: dir,
        encoding: "utf8",
        timeout: 60000,
        env: { ...env, ...extra },
      });
    const cli = invoke([join(src, "cli.ts"), "run", "1.feature", "--max-turns", "4"], { DECISIUM_MAX_TURNS: "3" });
    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    let runs = readdirSync(join(dir, "artifacts"));
    const trace = readFileSync(join(dir, "artifacts", runs[0], "trace.jsonl"), "utf8");
    assert.equal(JSON.parse(trace.split("\n")[0]).settings.maxTurns, 4);
    const empty = invoke([join(src, "cli.ts"), "run", "1.feature", "--max-turns", ""]);
    assert.equal(empty.status, 2, empty.stdout + empty.stderr);
    rmSync(join(dir, "artifacts"), { recursive: true });
    const raw = invoke([cucumber, "1.feature", "2.feature", "--parallel", "2"]);
    assert.equal(raw.status, 1, raw.stdout + raw.stderr);
    assert.equal((raw.stderr.match(/Warning: confidence.answer/g) ?? []).length, 1, raw.stderr);
    runs = readdirSync(join(dir, "artifacts"));
    assert.ok(runs.some((run) => existsSync(join(dir, "artifacts", run, "report.md"))));
    for (const run of runs.filter((run) => existsSync(join(dir, "artifacts", run, "report.md")))) {
      const report = readFileSync(join(dir, "artifacts", run, "report.md"), "utf8");
      assert.match(report, /non-default confidence: target 0.5, answer 0.5/);
      assert.match(report, /--report-dir artifacts/);
      assert.match(report, /--max-turns 12/);
      assert.match(report, /--confidence-answer 0.5/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const KEYS = ["REPORT_DIR", "CONFIDENCE_TARGET", "CONFIDENCE_ANSWER", "CHECK_TIMEOUT", "ACTION_TIMEOUT", "MAX_TURNS"];
/** Runs `fn` with these DECISIUM_* env values (the runner reads process.env), then restores it. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = KEYS.map((k) => [k, process.env[`DECISIUM_${k}`]] as const);
  for (const k of KEYS) delete process.env[`DECISIUM_${k}`];
  for (const [k, v] of Object.entries(vars)) process.env[`DECISIUM_${k}`] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved)
      v === undefined ? delete process.env[`DECISIUM_${k}`] : (process.env[`DECISIUM_${k}`] = v);
  }
}

const sure = (choice: string): Pick => ({ choice, probabilities: { [choice]: 0.99, other: 0.01 } });
const unused = async (): Promise<never> => {
  throw new Error("not used");
};
const base: Decider = { turn: unused, value: unused, assess: unused, recall: unused, dialog: unused, drop: unused };

test("settings: worldParameters fill env, env wins, values are validated", () => {
  const env: Record<string, string | undefined> = { DECISIUM_MAX_TURNS: "3" };
  const s = applyOptions(
    {
      reportDir: "e2e/runs",
      confidence: { target: 0.6, answer: 0.85 },
      checkTimeout: 10000,
      actionTimeout: 7000,
      maxTurns: 12,
    },
    env,
  );
  assert.deepEqual(s, {
    reportDir: "e2e/runs",
    confidence: { target: 0.6, answer: 0.85 },
    checkTimeout: 10000,
    actionTimeout: 7000,
    maxTurns: 3, // env (a flag) wins
  });
  assert.deepEqual(settings({}), {
    reportDir: "runs",
    confidence: { target: 0.5, answer: 0.8 },
    checkTimeout: 5000,
    actionTimeout: 5000,
    maxTurns: 8,
  });
  const bad: [unknown, RegExp][] = [
    [{ confidence: { answer: 1.5 } }, /confidence.answer must be a number in \(0, 1\]/],
    [{ confidence: { target: 0 } }, /confidence.target must be a number in \(0, 1\]/],
    [{ confidence: { lead: 0.2 } }, /confidence.lead is not an option/],
    [{ confidence: 0.5 }, /confidence must be an object/],
    [{ checkTimeout: 1.5 }, /checkTimeout must be a positive whole number/],
    [{ actionTimeout: "5000" }, /actionTimeout must be a number/],
    [{ maxTurns: 21 }, /maxTurns must be a whole number 1-20/],
    [{ maxTurns: 0 }, /maxTurns must be a whole number 1-20/],
    [{ reportDir: "" }, /reportDir must be a non-empty string/],
  ];
  for (const [params, err] of bad) assert.throws(() => applyOptions(params, {}), err);
  for (const key of KEYS) {
    assert.throws(() => applyOptions(undefined, { [`DECISIUM_${key}`]: "" }));
    assert.throws(() => applyOptions(undefined, { [`DECISIUM_${key}`]: " " }));
  }
  assert.throws(() => applyOptions({ maxTurns: 12 }, { DECISIUM_MAX_TURNS: "" }));
  assert.throws(() => applyOptions({ maxTurns: 21 }, { DECISIUM_MAX_TURNS: "2" }));
  assert.throws(() => applyOptions({ "confidence.answer": 0.6 }, {}));
  assert.throws(() => applyOptions({ constructor: 2 }, {}));
  assert.throws(() => applyOptions(undefined, { DECISIUM_CHECK_TIMEOUT: "soon" }), /checkTimeout must be/); // a flag
});

test("settings: confidence.answer warns only below 0.6, not for a lower target", () => {
  const warn = (env: Record<string, string>) => settingWarnings(settings(env));
  assert.match(warn({ DECISIUM_CONFIDENCE_ANSWER: "0.599" })[0], /confidence.answer 0.599 is below 0.6/);
  for (const answer of ["0.6", "0.7", "0.8"]) assert.deepEqual(warn({ DECISIUM_CONFIDENCE_ANSWER: answer }), []);
  assert.deepEqual(warn({}), []);
  assert.deepEqual(warn({ DECISIUM_CONFIDENCE_ANSWER: "0.9" }), []);
  assert.deepEqual(warn({ DECISIUM_CONFIDENCE_TARGET: "0.2" }), []);
});

test("settings: the gates read confidence.answer and confidence.target", async () => {
  const rt: Runtime = {
    actionStep: (run) => run(),
    observe: async () => parseSnapshot(`- button "Save" [disabled] [ref=e1]`, new Set(["e1"])),
    execute: async () => {},
    waitForChange: async () => false,
  };
  const state = { choice: "disabled", probabilities: { disabled: 0.7, enabled: 0.3 } };
  const checking: Decider = {
    ...base,
    assess: async () => ({ kind: sure("state"), subject: sure("e1"), area: sure("page"), state }),
  };
  const check = () => runAssertion("the Save button should be disabled", rt, checking, () => {});
  assert.equal((await withEnv({}, check)).outcome, "AMBIGUOUS");
  assert.equal((await withEnv({ CONFIDENCE_ANSWER: "0.6" }, check)).outcome, "PASSED");

  const target = { choice: "e1", probabilities: { e1: 0.55, e2: 0.4 } };
  const acting: Decider = { ...base, turn: async () => ({ done: 0, target }) };
  const act = () => runStep("Click Save", rt, acting, () => {});
  assert.equal((await withEnv({ CONFIDENCE_TARGET: "0.6" }, act)).outcome, "AMBIGUOUS");
});

test("settings: maxTurns and checkTimeout stop a page that never settles", async () => {
  let n = 0;
  const rt: Runtime = {
    actionStep: (run) => run(),
    observe: async () =>
      parseSnapshot(`- button "Next ${n}" [ref=e1]\n- paragraph [ref=e2]: Step ${n}`, new Set(["e1"])),
    execute: async () => {
      n++;
    },
    waitForChange: async (_since, ms = 0) => {
      await new Promise((r) => setTimeout(r, Math.min(ms, 20)));
      n++;
      return true; // always changes, never reaches the expected state
    },
  };
  const never: Decider = { ...base, turn: async () => ({ done: 0, target: sure("e1") }) };
  const r = await withEnv({ MAX_TURNS: "2" }, () => runStep("Finish the wizard", rt, never, () => {}));
  assert.equal(r.outcome, "STEP_TIMEOUT");
  assert.match(r.reason!, /after 2 actions/);

  const checking: Decider = {
    ...base,
    assess: async () => ({ kind: sure("value"), subject: sure("e2"), area: sure("page"), state: sure("disabled") }),
  };
  const t = Date.now();
  const c = await withEnv({ CHECK_TIMEOUT: "200" }, () =>
    runAssertion(`the step should show "Done"`, rt, checking, () => {}),
  );
  const took = Date.now() - t;
  assert.equal(c.outcome, "ASSERTION_FAILED");
  assert.ok(took >= 180 && took < 1500, `check waited ${took} ms`);
});

test("settings: reportDir holds the run folders", () => {
  const root = mkdtempSync(join(tmpdir(), "decisium-"));
  try {
    const run = new RunDir(join(root, "e2e/runs"));
    assert.ok(existsSync(run.path));
    assert.deepEqual(readdirSync(join(root, "e2e/runs")), [run.path.split("/").at(-1)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
