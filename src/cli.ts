#!/usr/bin/env node
import { loadConfiguration, runCucumber } from "@cucumber/cucumber/api";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { RECORD_MODES, type RecordMode } from "./cassette.ts";
import { parseFeature, stepFeature, type Scenario } from "./feature.ts";
import { applyOptions, ourStdout, settingWarnings, type Settings } from "./options.ts";
import { doctor } from "./doctor.ts";
import { lint } from "./lint.ts";
import { INFRA_MARKER, RunDir } from "./trace.ts";
import { MODEL } from "./jev.ts";

// ".ts" from source, ".js" from the built package in dist/.
const EXT = import.meta.url.slice(-3);

const COMMANDS: Record<string, { synopsis: string; notes: string }> = {
  step: {
    synopsis: 'decisium step "<step>" --url <url|file> [--headed] [--judged] [--strict] [-v] [--debug]',
    notes: `--url: start URL or file.
--headed: show the browser.
-v / --verbose prints every Observation and Jev answer; --debug shows stack traces.
--judged lets Jev judge fuzzy checks; they report JUDGED_PASSED/JUDGED_FAILED, never PASSED.
--strict: a barely-confident passing check fails as AMBIGUOUS.`,
  },
  run: {
    synopsis:
      "decisium run <file.feature[:line]>... [--url <url|file>] [--headed] [--judged] [--strict] [--record <mode>]\n                [--parallel <n|auto>] [--report-dir <dir>]\n                [--confidence-target <p>] [--confidence-answer <p>] [--check-timeout <ms>] [--action-timeout <ms>]\n                [--max-turns <n>] [--format <name[:path]>] [--import <file>] [-p <profile>] [--no-agent-report] [-v] [--debug]",
    notes: `The start URL comes from --url or an @url:<url> tag (scenario tags override feature tags). file.feature:line runs only
the scenario (or Examples row) at that line.
--record (run only): what each Step resolved to (element role, name, container, position; values) is recorded in
  <file>.cassette.json and replayed without Jev while exactly one element still matches it.
  new (default): replay, resolve new or no-longer-matching Steps live and write them back (reported as healed);
  none: replay only, a missing or broken resolution fails as UI_CHANGED (CI); all: resolve everything live, rewrite.
--parallel <n|auto>: worker processes. Features run side by side, a feature's scenarios one after another. Only for
  features that do not share app state. auto: min(CPUs, 4) when calling Jev, every CPU with --record none. Default 0.
Configuration is cucumber-js's: run loads your cucumber.{js,mjs,cjs,json,yaml} (and -p profiles); --format, --import and
  -p (repeatable) are cucumber's flags, added to it. --format name[:path]: cucumber's junit, json, html, message or any
  formatter package, e.g. --format junit:junit.xml or --format cucumberjs-qase-reporter:/dev/null. Only one formatter may
  write to stdout: one configured without a path takes it, else Decisium's console output does.
--import: your own cucumber step definitions or hooks. A line one of them matches runs it, not Jev; the World gives them
  this.page (the current tab) and this.context (Playwright). See andletenkov.github.io/decisium/client-steps.html.
Options in the configuration: worldParameters: { decisium: { url, record, headed, judged, strict, verbose, debug,
  agentReport, reportDir, confidence: { target, answer }, checkTimeout, actionTimeout, maxTurns } }; flags and DECISIUM_*
  env (DECISIUM_URL, DECISIUM_RECORD, DECISIUM_STRICT=1, DECISIUM_MAX_TURNS, ...) override them.
--report-dir <dir>: where run folders go (default runs).
--confidence-target <p>: how sure Jev must be of the element an action acts on (default 0.5).
--confidence-answer <p>: how sure Jev must be of every other answer (default 0.8; lower lets a wrong reading pass).
--check-timeout <ms>: how long a check waits for the expected state (default 5000).
--action-timeout <ms>: how long after an action to wait for the page to settle (default 5000).
--max-turns <n>: actions a Step may take before STEP_TIMEOUT (1-20, default 8).
-v prints every Observation and Jev answer (always saved to <report-dir>/<timestamp>/log.txt); --debug shows stack traces.
--judged lets Jev judge fuzzy checks; they report JUDGED_PASSED/JUDGED_FAILED, never PASSED.
--strict: a check that passes on a barely-confident Jev answer (shown as "marginal pass") fails as AMBIGUOUS.

Each run writes <report-dir>/<timestamp>/ (default runs/): trace.jsonl (Observations, Jev answers, actions, outcomes, time per phase) and per
failed scenario a screenshot per Turn (--record none: of the failed Step), playwright-trace.zip, console-errors.txt and
ui.txt (the page text). Passed scenarios keep none.
A run with a failure writes report.md: every failure with Jev's answers, the page text around it and a rerun command,
for a coding agent (--no-agent-report: off).

Runs inside cucumber-js: raw \`npx cucumber-js <file>\` works too with
import: ["node_modules/decisium/dist/steps.js"] and format: ["decisium/formatter"] in its cucumber.mjs.

Secrets: write "$NAME" in a Step's quotes (e.g. with password "$SAUCE_PASSWORD"): Jev, logs, trace and cassette see only
the token; the value comes from the environment (or .env) and is typed into the page. Wherever the page shows it, it is
masked back to the token. A scenario that typed one keeps no Playwright trace (it would store the value). A value
written literally in a Step is sent to Jev, recorded in the cassette and written to log.txt.

Exit codes: 0 passed, 1 a scenario failed, 2 configuration/infrastructure error.`,
  },
  doctor: {
    synopsis: "decisium doctor [<file.feature>...]",
    notes:
      "Checks Node, Chromium and TYPESAFE_API_KEY (one tiny Jev call); given features, also opens every start URL.",
  },
  lint: {
    synopsis: "decisium lint <file.feature>...",
    notes:
      "Uses no browser, no Jev. Per Step: its kind, quoted values, keys, secret placeholders, and warnings for wordings\n  the docs mark as ones to avoid (andletenkov.github.io/decisium/steps.html).",
  },
};

const USAGE = `Usage:
${Object.values(COMMANDS)
  .map(({ synopsis }) => `  ${synopsis}`)
  .join("\n")}

--help / -h: show help. decisium help <command>: show command-specific help.
--version / -V: print installed version.
Exit codes: 0 passed, 1 a scenario failed, 2 configuration/infrastructure error.`;

function usage(command?: string): string {
  const entry = command && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  return entry ? `Usage:\n  ${entry.synopsis}\n\n${entry.notes}\n\n--help / -h: show this help.` : USAGE;
}

async function main(): Promise<number> {
  const feature = (path: string) => path.replace(/:\d+$/, ""); // file.feature:line -> file.feature
  const config = {
    allowPositionals: true,
    allowNegative: true,
    // No defaults: an option not given falls back to DECISIUM_* env, then worldParameters.decisium (src/options.ts).
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      url: { type: "string" },
      headed: { type: "boolean" },
      judged: { type: "boolean" },
      strict: { type: "boolean" },
      "agent-report": { type: "boolean" },
      record: { type: "string" },
      parallel: { type: "string" },
      format: { type: "string", multiple: true, default: [] },
      import: { type: "string", multiple: true, default: [] },
      profile: { type: "string", short: "p", multiple: true, default: [] },
      verbose: { type: "boolean", short: "v" },
      debug: { type: "boolean" },
      "report-dir": { type: "string" },
      "confidence-target": { type: "string" },
      "confidence-answer": { type: "string" },
      "check-timeout": { type: "string" },
      "action-timeout": { type: "string" },
      "max-turns": { type: "string" },
    },
  } satisfies ParseArgsConfig;
  let parsed: ReturnType<typeof parseArgs<typeof config>>;
  try {
    parsed = parseArgs(config);
  } catch (err) {
    const error = err as Error;
    const { positionals } = parseArgs({ ...config, strict: false });
    const command = positionals[0] === "help" ? positionals[1] : positionals[0];
    console.error(`Error: ${error.message.split(". To specify")[0]}\n\n${usage(command)}`);
    return 2;
  }
  const { positionals, values } = parsed;
  const [cmd, arg] = positionals;
  const command = cmd === "help" ? arg : cmd;
  if (command && !Object.hasOwn(COMMANDS, command)) {
    console.error(`Error: unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  if (values.version) {
    console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    return 0;
  }
  if (values.help || cmd === "help") {
    console.log(usage(command));
    return 0;
  }
  if (existsSync(".env")) process.loadEnvFile(".env"); // TYPESAFE_API_KEY; never logged
  const env = process.env;
  const flag = (on?: boolean) => (on === undefined ? undefined : on ? "1" : "0");
  for (const [name, value] of Object.entries({
    URL: values.url,
    RECORD: values.record,
    HEADED: flag(values.headed),
    JUDGED: flag(values.judged),
    STRICT: flag(values.strict),
    NO_AGENT_REPORT: flag(values["agent-report"] === undefined ? undefined : !values["agent-report"]),
    VERBOSE: flag(values.verbose),
    DEBUG: flag(values.debug),
    REPORT_DIR: values["report-dir"],
    CONFIDENCE_TARGET: values["confidence-target"],
    CONFIDENCE_ANSWER: values["confidence-answer"],
    CHECK_TIMEOUT: values["check-timeout"],
    ACTION_TIMEOUT: values["action-timeout"],
    MAX_TURNS: values["max-turns"],
  }))
    if (value !== undefined) env[`DECISIUM_${name}`] = value;
  if (cmd === "doctor") return doctor(positionals.slice(1));
  if (cmd === "lint" && arg) {
    try {
      console.log(
        positionals
          .slice(1)
          .map((f) => lint(f))
          .join("\n\n"),
      );
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
      const file = join(mkdtempSync(join(tmpdir(), "decisium-")), "step.feature");
      writeFileSync(file, stepFeature(arg));
      files = [file];
      const dir = dirname(file);
      process.on("exit", () => rmSync(dir, { recursive: true, force: true })); // every exit path, early returns included
    } else if (cmd === "run" && arg) {
      files = positionals.slice(1);
      const missing = files.find((f) => !existsSync(feature(f)));
      if (missing) {
        console.error(`File not found: ${missing}`);
        return 2;
      }
    } else {
      console.error(usage(cmd));
      return 2;
    }
    scenarios = files.flatMap((f) => parseFeature(readFileSync(feature(f), "utf8"), feature(f))); // syntax and unsupported arguments: one line, before running
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const parallelSet = values.parallel === "auto" ? -1 : Number(values.parallel ?? 0); // -1: auto, resolved once --record is known
  if (!Number.isInteger(parallelSet) || parallelSet < -1) {
    console.error(`--parallel must be a whole number or auto\n\n${usage(cmd)}`);
    return 2;
  }
  const here = (f: string) => fileURLToPath(import.meta.resolve(f));
  // The client's cucumber configuration and profiles, plus ours; `step` runs one line, so none of the client's features.
  const { useConfiguration, runConfiguration } = await loadConfiguration({
    file: cmd === "step" ? false : undefined,
    profiles: values.profile,
    provided: {
      paths: files,
      import: [here(`./steps${EXT}`), ...values.import.map((f) => resolve(f))],
      format: values.format,
    },
  });
  if (ourStdout(useConfiguration.format, runConfiguration.formats.stdout))
    runConfiguration.formats.stdout = here(`./formatter${EXT}`);
  let settings: Settings;
  try {
    settings = applyOptions((runConfiguration.runtime.worldParameters as { decisium?: unknown } | undefined)?.decisium);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  // Values after the merge: the configuration may set what no flag did.
  const record = env.DECISIUM_RECORD || "new";
  if (!RECORD_MODES.includes(record as RecordMode)) {
    console.error(`--record must be one of ${RECORD_MODES.join(", ")}\n\n${usage(cmd)}`);
    return 2;
  }
  const missingUrl = scenarios.find((s) => !(env.DECISIUM_URL || s.url));
  if (missingUrl) {
    console.error(`No start URL for "${missingUrl.name}": pass --url or add an @url:<url> tag.\n\n${usage(cmd)}`);
    return 2;
  }
  if (!env.TYPESAFE_API_KEY && (cmd === "step" || record !== "none" || env.DECISIUM_JUDGED === "1")) {
    console.error("TYPESAFE_API_KEY is not set.");
    return 2;
  }
  // Opt-in: features sharing one stateful app (campaign-manager) break each other's state when run side by side.
  // Workers only pay off across features (a feature's scenarios share its cassette and run in sequence).
  if (values.parallel !== undefined)
    runConfiguration.runtime.parallel =
      files.length < 2
        ? 0
        : parallelSet === -1
          ? Math.min(availableParallelism(), record === "none" ? Infinity : 4)
          : parallelSet;
  const run = new RunDir(settings.reportDir); // shared by every worker
  Object.assign(env, { DECISIUM_STEP: cmd === "step" ? "1" : "", DECISIUM_RUN_DIR: run.path });
  run.event("run", { settings });
  for (const w of settingWarnings(settings)) console.warn(w);
  console.log(`Model: ${MODEL}\nRun directory: ${run.path}`);
  const { success } = await runCucumber(runConfiguration);
  run.done();
  console.log(`\nRun directory: ${run.path} (log.txt has the full decision log)`);
  // steps.ts marks an infrastructure error in the run directory (it may have happened in a worker).
  return process.exitCode === 2 || existsSync(join(run.path, INFRA_MARKER)) ? 2 : success ? 0 : 1;
}

// No process.exit on success paths: a reporter (e.g. Qase's) may finish uploading after cucumber returns.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(
      process.env.DECISIUM_DEBUG
        ? err
        : `\nError: ${(err as Error).message.split("\n")[0]}\nRerun with --debug for details.`,
    );
    process.exitCode = 2;
  },
);
