#!/usr/bin/env node
import { loadConfiguration, runCucumber } from "@cucumber/cucumber/api";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RECORD_MODES, type RecordMode } from "./cassette.ts";
import { parseFeature, stepFeature, type Scenario } from "./feature.ts";
import { qaseOn, qasePreflight } from "./qase.ts";
import { doctor } from "./doctor.ts";
import { explain } from "./explain.ts";
import { INFRA_MARKER, RunDir } from "./trace.ts";
import { MODEL } from "./jev.ts";

const USAGE = `Usage:
  descisium step "<step>" --url <url|file> [--headed] [--judged] [--strict] [-v] [--debug]
  descisium run <file.feature[:line]>... [--url <url|file>] [--headed] [--judged] [--strict] [--record <mode>] [--reporter junit|json[:path]]
                [--parallel <n|auto>] [--no-agent-report] [-v] [--debug]
  descisium doctor [<file.feature>...]
  descisium explain <file.feature>...

The start URL comes from --url or an @url:<url> tag (scenario tags override feature tags). file.feature:line runs only
the scenario (or Examples row) at that line.
--record (run only): Jev answers are recorded in <file>.cassette.json and replayed for identical requests.
  once (default): record if no cassette exists, else replay only; none: replay only, a miss fails as UI_CHANGED;
  new: replay, record misses live; all: always call Jev and rewrite the cassette.
--reporter (repeatable): junit or json, written to the run directory (junit.xml, report.json) or to :path.
--parallel <n|auto>: worker processes. Features run side by side, a feature's scenarios one after another. Only for
  features that do not share app state. auto: min(CPUs, 4) when calling Jev, every CPU with --record none. Default 0.
doctor: checks Node, Chromium, TYPESAFE_API_KEY (one tiny Jev call) and Qase if enabled; given features, also opens
  every start URL.
explain: no browser, no Jev. Per Step: its kind, the quoted values, secret placeholders, and warnings for wordings
  docs/cookbook.md shows failing.
-v prints every Observation and Jev answer (always saved to runs/<timestamp>/log.txt); --debug shows stack traces.
--judged lets Jev judge fuzzy checks; they report JUDGED_PASSED/JUDGED_FAILED, never PASSED.
--strict: a check that passes on a barely-confident Jev answer (shown as "marginal pass") fails as AMBIGUOUS.

Each run writes runs/<timestamp>/: trace.jsonl (Observations, Jev answers, actions, outcomes) and per scenario a
screenshot per Turn; failed scenarios also get playwright-trace.zip, console-errors.txt and ui.txt (the page text).
A run with a failure writes report.md: every failure with Jev's answers, the page text around it and a rerun command,
for a coding agent (--no-agent-report: off).

Runs inside cucumber-js (raw \`npx cucumber-js <file>\` works too, see cucumber.mjs; options as DESCISIUM_* env).
Qase: tag scenarios @QaseID=<id> and set QASE_MODE=testops, QASE_TESTOPS_API_TOKEN, QASE_TESTOPS_PROJECT
(QASE_TESTOPS_RUN_ID to report into an existing run). QASE_MODE=report writes the results to build/qase-report.

Secrets: write "$NAME" in a Step's quotes (e.g. with password "$SAUCE_PASSWORD"): Jev, logs, trace and cassette see only
the token; the value comes from the environment (or .env) and is typed into the page. Wherever the page shows it, it is
masked back to the token. A scenario that typed one keeps no Playwright trace (it would store the value). A value
written literally in a Step is sent to Jev, recorded in the cassette and written to log.txt.

Exit codes: 0 passed, 1 a scenario failed, 2 configuration/infrastructure error.`;


async function main(): Promise<number> {
  const feature = (path: string) => path.replace(/:\d+$/, ""); // file.feature:line -> file.feature
  if (existsSync(".env")) process.loadEnvFile(".env"); // TYPESAFE_API_KEY, QASE_*; never logged
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: { url: { type: "string" }, headed: { type: "boolean", default: false }, judged: { type: "boolean", default: false },
      strict: { type: "boolean", default: false }, "agent-report": { type: "boolean", default: true },
      record: { type: "string", default: "once" },
      reporter: { type: "string", multiple: true, default: [] }, parallel: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false }, debug: { type: "boolean", default: false } },
  });
  const [cmd, arg] = positionals;
  if (cmd === "doctor") return doctor(positionals.slice(1));
  if (cmd === "explain" && arg) {
    try {
      console.log(positionals.slice(1).map(f => explain(f)).join("\n\n"));
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
  }
  let files: string[];
  let scenarios: Scenario[];
  try {
    if (cmd === "step" && arg) {
      const file = join(mkdtempSync(join(tmpdir(), "descisium-")), "step.feature");
      writeFileSync(file, stepFeature(arg));
      files = [file];
      const dir = dirname(file);
      process.on("exit", () => rmSync(dir, { recursive: true, force: true })); // every exit path, early returns included
    } else if (cmd === "run" && arg) {
      files = positionals.slice(1);
      const missing = files.find(f => !existsSync(feature(f)));
      if (missing) { console.error(`File not found: ${missing}`); return 2; }
    } else {
      console.error(USAGE);
      return 2;
    }
    scenarios = files.flatMap(f => parseFeature(readFileSync(feature(f), "utf8"), feature(f))); // syntax and unsupported arguments: one line, before running
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (!RECORD_MODES.includes(values.record as RecordMode)) { console.error(`--record must be one of ${RECORD_MODES.join(", ")}\n\n${USAGE}`); return 2; }
  const missingUrl = scenarios.find(s => !(values.url ?? s.url));
  if (missingUrl) { console.error(`No start URL for "${missingUrl.name}": pass --url or add an @url:<url> tag.\n\n${USAGE}`); return 2; }
  if (!process.env.TYPESAFE_API_KEY && (cmd === "step" || values.record !== "none")) { console.error("TYPESAFE_API_KEY is not set."); return 2; }
  const reporters = values.reporter.map(r => /^(junit|json)(?::(.+))?$/.exec(r));
  if (reporters.some(r => !r)) { console.error(`--reporter must be junit or json, optionally :path\n\n${USAGE}`); return 2; }
  // Opt-in: features sharing one stateful app (campaign-manager) break each other's state when run side by side.
  const parallel = values.parallel === "auto" ? Math.min(availableParallelism(), values.record === "none" ? Infinity : 4) : Number(values.parallel ?? 0);
  if (!Number.isInteger(parallel) || parallel < 0) { console.error(`--parallel must be a whole number or auto\n\n${USAGE}`); return 2; }
  const qaseError = await qasePreflight(scenarios);
  if (qaseError) { console.error(qaseError); return 2; }
  const run = new RunDir(); // shared by every worker

  const flag = (on: boolean) => (on ? "1" : "");
  Object.assign(process.env, {
    DESCISIUM_URL: values.url ?? "", DESCISIUM_RECORD: values.record, DESCISIUM_STEP: flag(cmd === "step"),
    DESCISIUM_HEADED: flag(values.headed), DESCISIUM_JUDGED: flag(values.judged), DESCISIUM_STRICT: flag(values.strict),
    DESCISIUM_NO_AGENT_REPORT: flag(!values["agent-report"]),
    DESCISIUM_VERBOSE: flag(values.verbose), DESCISIUM_DEBUG: flag(values.debug),
    DESCISIUM_RUN_DIR: run.path,
  });
  const reports = reporters.map(r => [r![1], r![2] ?? join(run.path, r![1] === "junit" ? "junit.xml" : "report.json")] as [string, string]);
  const here = (f: string) => fileURLToPath(import.meta.resolve(f));
  const { runConfiguration } = await loadConfiguration({ file: false, provided: {
    paths: files, import: [here("./steps.ts")],
    // Workers only pay off across features (a feature's scenarios share its cassette and run in sequence).
    parallel: files.length > 1 ? parallel : 0,
    // Only one formatter may write to stdout; the Qase reporter writes nothing there itself.
    format: [here("./formatter.ts"), ...reports, ...(qaseOn() ? [[here("./qase-reporter.ts"), devNull] as [string, string]] : [])],
  } });
  console.log(`Model: ${MODEL}\nRun directory: ${run.path}`);
  const { success } = await runCucumber(runConfiguration);
  run.done();
  console.log(`\nRun directory: ${run.path} (log.txt has the full decision log)`);
  // steps.ts marks an infrastructure error in the run directory (it may have happened in a worker).
  return process.exitCode === 2 || existsSync(join(run.path, INFRA_MARKER)) ? 2 : success ? 0 : 1;
}

// No process.exit on success paths: the Qase reporter finishes uploading after cucumber returns.
main().then(code => { process.exitCode = code; }, err => {
  console.error(process.env.DESCISIUM_DEBUG ? err : `\nError: ${(err as Error).message.split("\n")[0]}\nRerun with --debug for details.`);
  process.exitCode = 2;
});
