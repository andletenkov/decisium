#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Browser } from "./browser.ts";
import { JevDecider, MODEL } from "./jev.ts";
import { runAssertion, runStep } from "./runner.ts";
import { parseTestFile, type ParsedStep } from "./testfile.ts";

const USAGE = `Usage:
  descisium step "<step text>" --url <url|file> [--headed] [--judged]
  descisium run <test-file> [--url <url|file>] [--headed] [--judged]

--judged lets Jev judge fuzzy checks; they report JUDGED_PASSED/JUDGED_FAILED, never PASSED.

Exit codes: 0 passed, 1 test failed, 2 configuration/infrastructure error.`;

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
    options: { url: { type: "string" }, headed: { type: "boolean", default: false }, judged: { type: "boolean", default: false } },
  });
  const [cmd, arg] = positionals;
  let steps: ParsedStep[];
  let url = values.url;

  if (cmd === "step" && arg) steps = parseTestFile(arg).steps; // "Then ..." / "Attempt ..." set the Step kind
  else if (cmd === "run" && arg) {
    if (!existsSync(arg)) { console.error(`File not found: ${arg}`); return 2; }
    const file = parseTestFile(readFileSync(arg, "utf8"));
    if (file.name) console.log(`Test: ${file.name}`);
    steps = file.steps;
    url ??= file.url;
  } else {
    console.error(USAGE);
    return 2;
  }
  if (!steps.length) { console.error("No steps found."); return 2; }
  if (!url) { console.error("No start URL: pass --url or add a `URL:` line.\n\n" + USAGE); return 2; }
  if (!process.env.TYPESAFE_API_KEY) { console.error("TYPESAFE_API_KEY is not set."); return 2; }

  console.log(`Model: ${MODEL}  URL: ${url}`);
  const browser = await Browser.open(toUrl(url), values.headed);
  const decider = new JevDecider();
  try {
    for (const step of steps) {
      const r = step.kind === "assertion"
        ? await runAssertion(step.text, browser, decider, console.log, values.judged)
        : await runStep(step.text, browser, decider, console.log, step.kind === "attempt");
      if (!["DONE", "PASSED", "JUDGED_PASSED"].includes(r.outcome)) { console.log(`\nFAILED at: ${step.text}`); return 1; }
    }
    console.log("\nPASSED");
    return 0;
  } finally {
    await browser.close();
  }
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(2); });
