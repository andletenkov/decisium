import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Decider, Pick } from "../src/decision.ts";
import { parseSnapshot } from "../src/observation.ts";
import { applyOptions, settings, settingWarnings } from "../src/options.ts";
import { runAssertion, runStep, type Runtime } from "../src/runner.ts";
import { RunDir } from "../src/trace.ts";

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
  assert.throws(() => applyOptions(undefined, { DECISIUM_CHECK_TIMEOUT: "soon" }), /checkTimeout must be/); // a flag
});

test("settings: lowering confidence.answer warns; the default, higher, or a lower target do not", () => {
  const warn = (env: Record<string, string>) => settingWarnings(settings(env));
  assert.match(warn({ DECISIUM_CONFIDENCE_ANSWER: "0.6" })[0], /confidence.answer 0.6 is below the default 0.8/);
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
