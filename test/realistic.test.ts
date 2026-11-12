// Realistic fixtures (issue #91): app screens at the scale and shape of real ones, each carrying one known risk of #90.
// Their cassettes replay without a key, and each #90 regression, reintroduced, fails a check here.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Browser } from "../src/browser.ts";
import { Cassette } from "../src/cassette.ts";
import type { Assessment, Decider, Pick } from "../src/decision.ts";
import { executeStep } from "../src/execute.ts";
import type { Observation } from "../src/observation.ts";
import { runAssertion } from "../src/runner.ts";

const DIR = "test/fixtures/realistic";
const page = (name: string) => pathToFileURL(`${DIR}/${name}`).href;
const pick = (probabilities: Record<string, number>): Pick => ({
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0],
  probabilities,
});
const unused = async () => {
  throw new Error("not used");
};

test("realistic fixture cassettes replay with no key: every Step passes, no Jev call (#90, problem 3 among them)", async () => {
  const features = readdirSync(DIR)
    .filter((f) => f.endsWith(".feature"))
    .map((f) => `${DIR}/${f}`);
  const before = features.map((f) => readFileSync(f.replace(/\.feature$/, ".cassette.json"), "utf8"));
  // A new run ID: items.feature's error shows it slugified, which the recording holds only as volatile text.
  const out = await promisify(execFile)(
    "node",
    ["src/cli.ts", "run", ...features, "--record", "none", "--no-agent-report", "--parallel", "auto"],
    {
      env: {
        ...process.env,
        TYPESAFE_API_KEY: "",
        OPENROUTER_API_KEY: "",
        DECISIUM_MODEL_API_KEY: undefined,
        DECISIUM_RUN_ID: undefined,
      },
    },
  ).then(
    (o) => o.stdout,
    (e: { stdout: string }) => e.stdout,
  );
  const run = /Run directory: (\S+)/.exec(out)![1];
  const steps = readFileSync(`${run}/trace.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "step");
  assert.ok(steps.length >= 15, out);
  assert.equal(
    steps.reduce((n, s) => n + s.jevCalls, 0),
    0,
  );
  for (const s of steps) assert.ok(["DONE", "PASSED"].includes(s.outcome), `${s.at}: ${s.outcome} ${s.reason ?? ""}`);
  assert.deepEqual(
    features.map((f) => readFileSync(f.replace(/\.feature$/, ".cassette.json"), "utf8")),
    before,
  );
});

test("what a check reads is recorded by structure, never by its text (issue #91)", () => {
  for (const name of ["form", "items", "models", "shell"]) {
    const { entries } = JSON.parse(readFileSync(`${DIR}/${name}.cassette.json`, "utf8"));
    for (const [key, e] of Object.entries(entries) as [string, { check?: { subject: unknown; area: unknown } }][])
      if (e.check) {
        const recorded = JSON.stringify([e.check.subject, e.check.area]);
        assert.doesNotMatch(recorded, /"(near|anchor)"/, key);
      }
    // The errors sit in an alert: their position there finds them, whatever text the app echoes.
    for (const [key, e] of Object.entries(entries) as [
      string,
      { check?: { subject: [{ scope?: { role: string } }][] } },
    ][])
      if (/error should say/.test(key)) assert.equal(e.check!.subject[0][0].scope?.role, "alert", key);
  }
});

test("on a large app screen a check that names no area reads the whole page, however the area answer spreads (#90, problem 1)", async () => {
  const b = await Browser.open(page("shell.html"));
  try {
    const save = (await b.observe()).elements.find((e) => e.name === "Save view")!;
    await b.execute({ verb: "CLICK", ref: save.ref });
    // The spreads #90 reported: page first but under the gate, the rest over main, group, generic and "missing".
    const spreads = (obs: Observation) => {
      const ref = (role: string) => obs.areas.find((e) => e.role === role)!.ref;
      const generic = obs.areas.filter((e) => e.role === "generic").map((e) => e.ref);
      return [
        { page: 0.59, none: 0.11, [ref("toolbar")]: 0.3 },
        { page: 0.41, [ref("main")]: 0.22, [ref("group")]: 0.14, [ref("navigation")]: 0.23 },
        { page: 0.38, [generic[0] ?? ref("group")]: 0.25, [ref("group")]: 0.11, [ref("navigation")]: 0.26 },
      ];
    };
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const jev = {
        turn: unused,
        value: unused,
        drop: unused,
        dialog: unused,
        recall: unused,
        async assess(_s: string, obs: Observation): Promise<Assessment> {
          return {
            kind: pick({ presence: 0.97, value: 0.03 }),
            negated: pick({ no: 0.99, yes: 0.01 }),
            state: pick({ enabled: 1 }),
            subject: pick({ none: 1 }),
            area: pick(spreads(obs)[i]),
            scoped: pick({ no: 0.95, yes: 0.05 }),
          };
        },
      } as unknown as Decider;
      outcomes.push((await runAssertion(`"View saved" should appear`, b, jev, () => {})).outcome);
    }
    assert.deepEqual(outcomes, ["PASSED", "PASSED", "PASSED"]);
  } finally {
    await b.close();
  }
});

test("a heal that ends AMBIGUOUS leaves the cassette unchanged (#90, problem 2)", async () => {
  const path = `${mkdtempSync(`${tmpdir()}/realistic-`)}/models.cassette.json`;
  copyFileSync(`${DIR}/models.cassette.json`, path);
  const before = readFileSync(path, "utf8");
  // ?late: the model options never come, so the recorded "Option A" is not offered and the Step heals live, where Jev
  // cannot tell which of the other comboboxes is meant.
  const b = await Browser.open(`${page("models.html")}?late`);
  try {
    const live = {
      intent: async () => ({}),
      async turn(_s: string, obs: Observation) {
        // The model combobox is disabled, so not offered: Jev is torn between the other two.
        const [provider, fallback] = ["Provider", "Fallback model"].map(
          (n) => obs.elements.find((e) => e.name === n)!.ref,
        );
        return { done: 0, target: pick({ [provider]: 0.48, [fallback]: 0.52 }), action: pick({ select: 1 }) };
      },
      value: async () => pick({ "Option A": 1 }),
      drop: unused,
      dialog: unused,
      recall: unused,
      assess: unused,
    } as unknown as Decider;
    const cassette = new Cassette(path, "jev-1.14.0", "new");
    const step = (text: string) =>
      executeStep(text, {
        rt: b,
        live,
        cassette,
        key: `Pick a model after the provider: ${text}`,
        kind: "action",
        arg: {},
        earlier: {},
        log: () => {},
      });
    assert.equal((await step(`I select "Northwind AI" as the provider`)).outcome, "DONE");
    assert.equal((await step(`I pick "Option A" as the model`)).outcome, "AMBIGUOUS");
    cassette.save();
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    await b.close();
  }
});
