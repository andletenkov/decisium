// cucumber-js support code (ADR 0003): one catch-all step definition runs every Step through Jev; hooks give each
// scenario a fresh browser, its run-directory folder, the feature's cassette and an empty memory.
// Options come from DESCISIUM_* env (set by `descisium run`), so raw `npx cucumber-js` works too.
import { After, AfterAll, Before, BeforeAll, BeforeStep, defineStep, setDefaultTimeout, setWorldConstructor, Status, World } from "@cucumber/cucumber";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Browser } from "./browser.ts";
import { Cassette, RECORD_MODES, UiChanged, type RecordMode } from "./cassette.ts";
import { stepKind, urlFromTags, type StepKind } from "./feature.ts";
import { JevDecider, MODEL, type Decider } from "./jev.ts";
import { quoted } from "./observation.ts";
import { outcomeMessage } from "./report.ts";
import { runAssertion, runStep, type Runtime, type StepResult } from "./runner.ts";
import { RunDir } from "./trace.ts";

const env = process.env;
const opt = (name: string) => env[`DESCISIUM_${name}`] === "1";
const record = (env.DESCISIUM_RECORD ?? "once") as RecordMode;

// Jev steps take seconds per Turn; the runner has its own caps (8 Turns, 5 s waits).
setDefaultTimeout(10 * 60_000);

// Local paths keep their ?query (e.g. index.html?decoy=1) instead of having it encoded into the file name.
const toUrl = (u: string) => {
  if (/^[a-z]+:\/\//i.test(u)) return u;
  const [path, query] = u.split(/(?=\?)/);
  return pathToFileURL(resolve(path)).href + (query ?? "");
};

// shortcut: module state assumes one process (no --parallel): each worker would get its own run directory and
// exit code 2 would not reach `descisium run`; move it into cucumber's worker/coordinator plugins when parallel is needed.
let run: RunDir;
let scenarios = 0;
let broken = false; // after an infrastructure error the remaining scenarios are skipped
const deciders = new Map<string, { cassette?: Cassette; decider: Decider }>(); // per feature file

class Scenario extends World {
  browser!: Browser;
  rt!: Runtime;
  decider!: Decider;
  dir = "";
  kind: StepKind = "action";
  earlier: Record<string, string> = {}; // memory: quoted value -> the Step that named it
}
setWorldConstructor(Scenario);

BeforeAll(function () {
  if (existsSync(".env")) process.loadEnvFile(".env"); // TYPESAFE_API_KEY; never logged
  if (!RECORD_MODES.includes(record)) throw new Error(`DESCISIUM_RECORD must be one of ${RECORD_MODES.join(", ")}`);
  if (!env.TYPESAFE_API_KEY && (record !== "none" || opt("STEP"))) throw new Error("TYPESAFE_API_KEY is not set.");
  run = new RunDir();
  console.log(`Model: ${MODEL}\nRun directory: ${run.path}`);
});

Before(async function (this: Scenario, { pickle }) {
  if (broken) return "skipped";
  const url = env.DESCISIUM_URL || urlFromTags(pickle.tags);
  if (!url) throw infra(new Error(`No start URL for "${pickle.name}": pass --url or add an @url:<url> tag.`));
  if (!deciders.has(pickle.uri)) {
    const cassette = opt("STEP") ? undefined : new Cassette(pickle.uri.replace(/\.feature$/, "") + ".cassette.json", MODEL, record);
    deciders.set(pickle.uri, { cassette, decider: run.decider(new JevDecider(cassette)) });
  }
  this.decider = deciders.get(pickle.uri)!.decider;
  run.log(`\n=== Scenario: ${pickle.name}  (${url})`);
  this.dir = run.scenario(scenarios++, pickle.name);
  try {
    this.browser = await Browser.open(toUrl(url), opt("HEADED"), true); // fresh browser per scenario: no shared state
  } catch (err) {
    throw infra(err);
  }
  this.rt = run.runtime(this.browser);
});

BeforeStep(function (this: Scenario, { pickleStep }) {
  this.kind = stepKind(pickleStep);
});

defineStep(/^(.*)$/, async function (this: Scenario, text: string) {
  const log = (line: string) => { run.log(line); if (opt("VERBOSE")) console.log(line); };
  let r: StepResult | { outcome: "UI_CHANGED"; reason: string };
  try {
    r = this.kind === "assertion"
      ? await runAssertion(text, this.rt, this.decider, log, opt("JUDGED"), { ...this.earlier })
      : await runStep(text, this.rt, this.decider, log, this.kind === "attempt");
  } catch (err) {
    if (!(err instanceof UiChanged)) throw infra(err);
    log(`  => UI_CHANGED`);
    r = { outcome: "UI_CHANGED", reason: `no recorded Jev answer for this page; what changed since the recording:\n${err.diff}` };
  }
  run.event("step", { kind: this.kind, step: text, ...r });
  for (const v of quoted(text)) this.earlier[v] = text;
  // The Step's last Turn screenshot; fileName carries its run-directory path to the console formatter.
  const shot = run.lastScreenshot;
  if (shot && existsSync(shot)) this.attach(readFileSync(shot), { mediaType: "image/png", fileName: shot });
  if (r.outcome === "JUDGED_PASSED") this.log(`JUDGED_PASSED: judged by Jev (${r.reason})`);
  if (!["DONE", "PASSED", "JUDGED_PASSED"].includes(r.outcome)) {
    const err = new Error(outcomeMessage(r));
    err.stack = err.message; // no stack frames: the Qase reporter reads keywords in them
    throw err;
  }
});

After(async function (this: Scenario, { result }) {
  if (!this.browser) return;
  const ok = result?.status === Status.PASSED;
  if (!ok) run.failure(this.browser.consoleErrors);
  await this.browser.close(ok ? undefined : `${this.dir}/playwright-trace.zip`);
  run.event("result", { passed: ok });
  for (const { cassette } of deciders.values()) cassette?.save(); // per scenario, so a crash keeps what was recorded
});

AfterAll(function () {
  if (!run) return;
  console.log(`\nRun directory: ${run.path} (log.txt has the full decision log)`);
  for (const { cassette: c } of deciders.values()) if (c) console.log(`Cassette ${c.path}: ${c.hits} replayed, ${c.recorded} recorded live`);
});

/** Infrastructure error (app not running, bad API key, network): one clear line, `--debug` for the stack. Exit code 2. */
function infra(err: unknown): Error {
  broken = true;
  process.exitCode = 2; // read by `descisium run`
  if (opt("DEBUG")) return err as Error;
  const e = err as Error & { status?: number };
  const out = new Error(`${e.message.split("\n")[0]}${e.status === 401 ? " (check TYPESAFE_API_KEY in .env)" : ""}\nRerun with --debug for details.`);
  out.stack = out.message;
  return out;
}
