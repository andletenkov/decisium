#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Browser } from "./browser.ts";
import { Cassette, RECORD_MODES, UiChanged, type RecordMode } from "./cassette.ts";
import { parseFeature, parseStep, type Scenario } from "./feature.ts";
import { JevDecider, MODEL } from "./jev.ts";
import { quoted } from "./observation.ts";
import { RunDir } from "./trace.ts";
import { runAssertion, runStep } from "./runner.ts";
import type { ParsedStep } from "./feature.ts";

/** What to do about each failure outcome, shown under the reason. */
const HINTS: Record<string, string> = {
  AMBIGUOUS: "Jev was not confident enough to decide. Make the step more specific: name the element or area (e.g. \"in the campaign list\").",
  UNVERIFIABLE: "Code cannot check this as written. Quote the exact text or value you expect.",
  ASSERTION_FAILED: "The page does not show what the check expects. Compare with the screenshot; if the app is right, update the step.",
  BLOCKED: "The control needed for this step is not on the screen. Check the screenshot: a previous step may have gone somewhere else, or a step to navigate is missing.",
  ELEMENT_NOT_FOUND: "The page changed while deciding. Rerun; if it repeats, the page may be re-rendering constantly.",
  ACTION_FAILED: "The browser could not perform the action (hidden, disabled or covered element). See the Playwright trace and console errors.",
  STEP_TIMEOUT: "The step needed more than 8 actions. Split it into smaller steps.",
  UI_CHANGED: "The page differs from the recorded cassette. If the change is intended, rerun with --record new (or --record all to re-record).",
  JUDGED_FAILED: "Jev judged that the page does not satisfy the check.",
};
const KIND = { action: "Step", attempt: "Attempt", assertion: "Check" } as const;

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

Exit codes: 0 passed, 1 a scenario failed, 2 configuration/infrastructure error.`;

// Local paths keep their ?query (e.g. index.html?decoy=1) instead of having it encoded into the file name.
const toUrl = (u: string) => {
  if (/^[a-z]+:\/\//i.test(u)) return u;
  const [path, query] = u.split(/(?=\?)/);
  return pathToFileURL(resolve(path)).href + (query ?? "");
};

async function main(): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env"); // TYPESAFE_API_KEY; never logged
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { url: { type: "string" }, headed: { type: "boolean", default: false }, judged: { type: "boolean", default: false },
      record: { type: "string", default: "once" },
      verbose: { type: "boolean", short: "v", default: false }, debug: { type: "boolean", default: false } },
  });
  const [cmd, arg] = positionals;
  let scenarios: Scenario[];
  try {
    if (cmd === "step" && arg) scenarios = [{ name: "step", steps: [parseStep(arg)] }];
    else if (cmd === "run" && arg) {
      if (!existsSync(arg)) { console.error(`File not found: ${arg}`); return 2; }
      scenarios = parseFeature(readFileSync(arg, "utf8"), arg);
    } else {
      console.error(USAGE);
      return 2;
    }
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (!RECORD_MODES.includes(values.record as RecordMode)) { console.error(`--record must be one of ${RECORD_MODES.join(", ")}\n\n${USAGE}`); return 2; }
  const missingUrl = scenarios.find(s => !(values.url ?? s.url));
  if (missingUrl) { console.error(`No start URL for "${missingUrl.name}": pass --url or add an @url:<url> tag.\n\n${USAGE}`); return 2; }
  const cassette = cmd === "run" ? new Cassette(arg.replace(/\.feature$/, "") + ".cassette.json", MODEL, values.record as RecordMode) : undefined;
  if (!process.env.TYPESAFE_API_KEY && values.record !== "none") { console.error("TYPESAFE_API_KEY is not set."); return 2; }

  debug = values.debug;
  console.log(`Model: ${MODEL}`);
  const run = new RunDir();
  console.log(`Run directory: ${run.path}`);
  const decider = run.decider(new JevDecider(cassette));
  const failed: string[] = [];
  const reports: string[] = [];
  const log = (line: string) => { run.log(line); if (values.verbose) console.log(line); };
  for (const [i, scenario] of scenarios.entries()) {
    const url = values.url ?? scenario.url!;
    console.log(`\n${scenario.name}  (${url})`);
    run.log(`\n=== Scenario: ${scenario.name}  (${url})`);
    const dir = run.scenario(i, scenario.name);
    const browser = await Browser.open(toUrl(url), values.headed, true); // fresh browser per scenario: no shared state
    const rt = run.runtime(browser);
    let ok = false;
    try {
      const earlier: Record<string, string> = {}; // memory: quoted value -> the Step that named it
      for (const step of scenario.steps) {
        let r: { outcome: string; reason?: string };
        try {
          r = step.kind === "assertion"
            ? await runAssertion(step.text, rt, decider, log, values.judged, { ...earlier })
            : await runStep(step.text, rt, decider, log, step.kind === "attempt");
        } catch (err) {
          if (!(err instanceof UiChanged)) throw err;
          log(`  => UI_CHANGED`);
          r = { outcome: "UI_CHANGED", reason: `no recorded Jev answer for this page; what changed since the recording:\n${err.diff}` };
        }
        const passed = ["DONE", "PASSED", "JUDGED_PASSED"].includes(r.outcome);
        console.log(`  ${passed ? "✓" : "✗"} ${KIND[step.kind]}: ${step.text}${r.outcome === "JUDGED_PASSED" ? "  (judged by Jev)" : ""}`);
        if (!passed) {
          const report = failure(cmd === "run" ? arg : "", scenario.name, step, r, run.lastScreenshot, `${dir}/playwright-trace.zip`);
          console.log(`      ${r.outcome}${r.reason ? `: ${r.reason}` : ""}`.replace(/\n/g, "\n      "));
          reports.push(report);
        }
        run.event("step", { kind: step.kind, step: step.text, ...r });
        for (const v of quoted(step.text)) earlier[v] = step.text;
        if (!passed) {
          failed.push(scenario.name);
          break;
        }
      }
      ok = !failed.includes(scenario.name);
    } finally {
      if (!ok) run.failure(browser.consoleErrors);
      await browser.close(ok ? undefined : `${dir}/playwright-trace.zip`);
      run.event("result", { passed: ok });
      cassette?.save(); // per scenario, so a crash keeps what was recorded
    }
  }
  if (reports.length) console.log(`\n${"─".repeat(60)}\nFailures\n\n${reports.join("\n\n")}`);
  console.log(`\nRun directory: ${run.path} (log.txt has the full decision log)`);
  if (cassette) console.log(`Cassette ${cassette.path}: ${cassette.hits} replayed, ${cassette.recorded} recorded live`);
  console.log(`\n${scenarios.length - failed.length}/${scenarios.length} scenarios passed${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  return failed.length ? 1 : 0;
}

let debug = false;

/** A failure in plain words: where, what, why, what to do, and where to look. */
function failure(file: string, scenario: string, step: ParsedStep, r: { outcome: string; reason?: string }, screenshot?: string, trace?: string): string {
  const where = file && step.line ? `${file}:${step.line}` : "command line";
  return [
    `✗ ${scenario}`,
    `  at ${where}  ${KIND[step.kind]}: ${step.text}`,
    `  ${r.outcome}${r.reason ? `: ${r.reason}` : ""}`,
    HINTS[r.outcome] && `  What to do: ${HINTS[r.outcome]}`,
    screenshot && `  Screenshot: ${screenshot}`,
    trace && `  Playwright trace: npx playwright show-trace ${trace}`,
  ].filter(Boolean).join("\n");
}

main().then(code => process.exit(code), err => {
  // Infrastructure errors (app not running, bad API key, network): one clear line; --debug for the stack.
  console.error(debug ? err : `\nError: ${(err as Error).message.split("\n")[0]}${err?.status === 401 ? " (check TYPESAFE_API_KEY in .env)" : ""}\nRerun with --debug for details.`);
  process.exit(2);
});
