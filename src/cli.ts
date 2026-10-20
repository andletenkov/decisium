#!/usr/bin/env node
import { loadConfiguration, runCucumber } from "@cucumber/cucumber/api";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RECORD_MODES, type RecordMode } from "./cassette.ts";
import { parseFeature, stepFeature, type Scenario } from "./feature.ts";
import { qaseOn, qasePreflight } from "./qase.ts";

const USAGE = `Usage:
  descisium step "<step>" --url <url|file> [--headed] [--judged] [-v] [--debug]
  descisium run <file.feature> [--url <url|file>] [--headed] [--judged] [--record <mode>] [-v] [--debug]

The start URL comes from --url or an @url:<url> tag (scenario tags override feature tags).
--record (run only): Jev answers are recorded in <file>.cassette.json and replayed for identical requests.
  once (default): record if no cassette exists, else replay only; none: replay only, a miss fails as UI_CHANGED;
  new: replay, record misses live; all: always call Jev and rewrite the cassette.
-v prints every Observation and Jev answer (always saved to runs/<timestamp>/log.txt); --debug shows stack traces.
--judged lets Jev judge fuzzy checks; they report JUDGED_PASSED/JUDGED_FAILED, never PASSED.

Each run writes runs/<timestamp>/: trace.jsonl (Observations, Jev answers, actions, outcomes) and per scenario a
screenshot per Turn; failed scenarios also get playwright-trace.zip and console-errors.txt.

Runs inside cucumber-js (raw \`npx cucumber-js <file>\` works too, see cucumber.mjs; options as DESCISIUM_* env).
Qase: tag scenarios @QaseID=<id> and set QASE_MODE=testops, QASE_TESTOPS_API_TOKEN, QASE_TESTOPS_PROJECT
(QASE_TESTOPS_RUN_ID to report into an existing run). QASE_MODE=report writes the results to build/qase-report.

Exit codes: 0 passed, 1 a scenario failed, 2 configuration/infrastructure error.`;


async function main(): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env"); // TYPESAFE_API_KEY, QASE_*; never logged
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { url: { type: "string" }, headed: { type: "boolean", default: false }, judged: { type: "boolean", default: false },
      record: { type: "string", default: "once" },
      verbose: { type: "boolean", short: "v", default: false }, debug: { type: "boolean", default: false } },
  });
  const [cmd, arg] = positionals;
  let file: string;
  let scenarios: Scenario[];
  try {
    if (cmd === "step" && arg) {
      file = join(mkdtempSync(join(tmpdir(), "descisium-")), "step.feature");
      writeFileSync(file, stepFeature(arg));
    } else if (cmd === "run" && arg) {
      if (!existsSync(arg)) { console.error(`File not found: ${arg}`); return 2; }
      file = arg;
    } else {
      console.error(USAGE);
      return 2;
    }
    scenarios = parseFeature(readFileSync(file, "utf8"), file); // syntax and unsupported arguments: one line, before running
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (!RECORD_MODES.includes(values.record as RecordMode)) { console.error(`--record must be one of ${RECORD_MODES.join(", ")}\n\n${USAGE}`); return 2; }
  const missingUrl = scenarios.find(s => !(values.url ?? s.url));
  if (missingUrl) { console.error(`No start URL for "${missingUrl.name}": pass --url or add an @url:<url> tag.\n\n${USAGE}`); return 2; }
  if (!process.env.TYPESAFE_API_KEY && (cmd === "step" || values.record !== "none")) { console.error("TYPESAFE_API_KEY is not set."); return 2; }
  const qaseError = await qasePreflight(scenarios);
  if (qaseError) { console.error(qaseError); return 2; }

  const flag = (on: boolean) => (on ? "1" : "");
  Object.assign(process.env, {
    DESCISIUM_URL: values.url ?? "", DESCISIUM_RECORD: values.record, DESCISIUM_STEP: flag(cmd === "step"),
    DESCISIUM_HEADED: flag(values.headed), DESCISIUM_JUDGED: flag(values.judged),
    DESCISIUM_VERBOSE: flag(values.verbose), DESCISIUM_DEBUG: flag(values.debug),
  });
  const here = (f: string) => fileURLToPath(import.meta.resolve(f));
  const { runConfiguration } = await loadConfiguration({ file: false, provided: {
    paths: [file], import: [here("./steps.ts")], // Only one formatter may write to stdout; the Qase reporter writes nothing there itself.
    format: [here("./formatter.ts"), ...(qaseOn() ? [[here("cucumberjs-qase-reporter"), devNull] as [string, string]] : [])],
  } });
  const { success } = await runCucumber(runConfiguration);
  return process.exitCode === 2 ? 2 : success ? 0 : 1; // steps.ts sets 2 on an infrastructure error
}

// No process.exit on success paths: the Qase reporter finishes uploading after cucumber returns.
main().then(code => { process.exitCode = code; }, err => {
  console.error(process.env.DESCISIUM_DEBUG ? err : `\nError: ${(err as Error).message.split("\n")[0]}\nRerun with --debug for details.`);
  process.exitCode = 2;
});
