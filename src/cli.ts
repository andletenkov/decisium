#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Browser } from "./browser.ts";
import { Cassette, RECORD_MODES, UiChanged, type RecordMode } from "./cassette.ts";
import { parseFeature, parseStep, type Scenario } from "./feature.ts";
import { JevDecider, MODEL } from "./jev.ts";
import { runAssertion, runStep } from "./runner.ts";

const USAGE = `Usage:
  descisium step "<step>" --url <url|file> [--headed] [--judged]
  descisium run <file.feature> [--url <url|file>] [--headed] [--judged] [--record <mode>]

The start URL comes from --url or an @url:<url> tag (scenario tags override feature tags).
--record (run only): Jev answers are recorded in <file>.cassette.json and replayed for identical requests.
  once (default): record if no cassette exists, else replay only; none: replay only, a miss fails as UI_CHANGED;
  new: replay, record misses live; all: always call Jev and rewrite the cassette.
--judged lets Jev judge fuzzy checks; they report JUDGED_PASSED/JUDGED_FAILED, never PASSED.

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
      record: { type: "string", default: "once" } },
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

  console.log(`Model: ${MODEL}`);
  const decider = new JevDecider(cassette);
  const failed: string[] = [];
  for (const scenario of scenarios) {
    const url = values.url ?? scenario.url!;
    console.log(`\n=== Scenario: ${scenario.name}  (${url})`);
    const browser = await Browser.open(toUrl(url), values.headed); // fresh browser per scenario: no shared state
    try {
      for (const step of scenario.steps) {
        let r;
        try {
          r = step.kind === "assertion"
            ? await runAssertion(step.text, browser, decider, console.log, values.judged)
            : await runStep(step.text, browser, decider, console.log, step.kind === "attempt");
        } catch (err) {
          if (!(err instanceof UiChanged)) throw err;
          console.log(`  => ${err.message}`);
          r = { outcome: "UI_CHANGED" };
        }
        if (!["DONE", "PASSED", "JUDGED_PASSED"].includes(r.outcome)) {
          console.log(`\nFAILED at: ${step.text}`);
          failed.push(scenario.name);
          break;
        }
      }
    } finally {
      await browser.close();
      cassette?.save(); // per scenario, so a crash keeps what was recorded
    }
  }
  if (cassette) console.log(`\nCassette ${cassette.path}: ${cassette.hits} replayed, ${cassette.recorded} recorded live`);
  console.log(`\n${scenarios.length - failed.length}/${scenarios.length} scenarios passed${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  return failed.length ? 1 : 0;
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(2); });
