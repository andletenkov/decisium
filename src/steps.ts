// cucumber-js support code (ADR 0003): one catch-all step definition runs every Step through Jev; hooks give each
// scenario a fresh browser, its run-directory folder, the feature's cassette and an empty memory.
// Options come from DESCISIUM_* env (set by `descisium run`), so raw `npx cucumber-js` works too.
import { After, AfterAll, Before, BeforeAll, BeforeStep, defineStep, setDefaultTimeout, setParallelCanAssign, setWorldConstructor, Status, World } from "@cucumber/cucumber";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser } from "./browser.ts";
import { Cassette, RECORD_MODES, UiChanged, type RecordMode } from "./cassette.ts";
import { stepKind, toUrl, urlFromTags, type StepKind } from "./feature.ts";
import { JevDecider, jevUsage, MODEL, type Decider } from "./jev.ts";
import { quoted } from "./observation.ts";
import { outcomeMessage } from "./report.ts";
import { runAssertion, runStep, type Runtime, type StepResult } from "./runner.ts";
import { RunDir } from "./trace.ts";

const env = process.env;
const opt = (name: string) => env[`DESCISIUM_${name}`] === "1";
const record = (env.DESCISIUM_RECORD ?? "once") as RecordMode;

// Jev steps take seconds per Turn; the runner has its own caps (8 Turns, 5 s waits).
setDefaultTimeout(10 * 60_000);


// Parallel workers (`--parallel`) are separate processes: the CLI creates the run directory (DESCISIUM_RUN_DIR) and an
// infrastructure error is signalled through a marker file in it, read by the CLI and by the other workers.
let run: RunDir;
const since = Number(env.DESCISIUM_RUN_START) || Date.now(); // run start, for cassettes shared across workers
const worker = !!env.DESCISIUM_RUN_DIR; // the CLI prints the run directory once, not each worker
const INFRA = "infrastructure-error";
const broken = () => !!run && existsSync(join(run.path, INFRA)); // after one, the remaining scenarios are skipped
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

// A feature's scenarios run one after another (they share its cassette); different features run side by side.
setParallelCanAssign((pickle, running) => !running.some(p => p.uri === pickle.uri));

BeforeAll(function () {
  if (existsSync(".env")) process.loadEnvFile(".env"); // TYPESAFE_API_KEY; never logged
  if (!RECORD_MODES.includes(record)) throw new Error(`DESCISIUM_RECORD must be one of ${RECORD_MODES.join(", ")}`);
  if (!env.TYPESAFE_API_KEY && (record !== "none" || opt("STEP"))) throw new Error("TYPESAFE_API_KEY is not set.");
  run = new RunDir("runs", env.DESCISIUM_RUN_DIR || undefined);
  if (!worker) console.log(`Model: ${MODEL}\nRun directory: ${run.path}`);
});

Before(async function (this: Scenario, { pickle }) {
  if (broken()) return "skipped";
  const url = env.DESCISIUM_URL || urlFromTags(pickle.tags);
  if (!url) throw infra(new Error(`No start URL for "${pickle.name}": pass --url or add an @url:<url> tag.`));
  try {
    if (!deciders.has(pickle.uri)) { // a corrupt cassette is a setup error, not a failed scenario
      const cassette = opt("STEP") ? undefined : new Cassette(pickle.uri.replace(/\.feature$/, "") + ".cassette.json", MODEL, record, since);
      deciders.set(pickle.uri, { cassette, decider: run.decider(new JevDecider(cassette)) });
    }
  } catch (err) {
    throw infra(err);
  }
  this.decider = deciders.get(pickle.uri)!.decider;
  run.log(`\n=== Scenario: ${pickle.name}  (${url})`);
  this.dir = run.scenario(pickle.name);
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
  let r: StepResult | { outcome: "UI_CHANGED" | "PAGE_TOO_LARGE"; reason: string };
  const start = Date.now(), before = { ...jevUsage };
  try {
    r = this.kind === "assertion"
      ? await runAssertion(text, this.rt, this.decider, log, opt("JUDGED"), { ...this.earlier })
      : await runStep(text, this.rt, this.decider, log, this.kind === "attempt");
  } catch (err) {
    if (/max_tokens_exceeded/.test(String((err as Error)?.message))) {
      // The page, not the setup: fail this Step and let the rest of the feature run (task 0021).
      log(`  => PAGE_TOO_LARGE`);
      r = { outcome: "PAGE_TOO_LARGE", reason: "the page is too large for one Jev request, even reduced to the sections that matter" };
    } else if (err instanceof UiChanged) {
      log(`  => UI_CHANGED`);
      r = { outcome: "UI_CHANGED", reason: err.reason };
    } else throw infra(err);
  }
  // Cost and time per Step: live Jev calls and tokens (cassette replays cost 0), wall-clock seconds.
  const cost = { seconds: (Date.now() - start) / 1000, jevCalls: jevUsage.calls - before.calls,
    inputTokens: jevUsage.inputTokens - before.inputTokens, outputTokens: jevUsage.outputTokens - before.outputTokens };
  run.event("step", { kind: this.kind, step: text, ...r, ...cost });
  for (const v of quoted(text)) this.earlier[v] = text;
  if (r.outcome === "JUDGED_PASSED") this.log(`JUDGED_PASSED: judged by Jev (${r.reason})`);
  if (!["DONE", "PASSED", "JUDGED_PASSED"].includes(r.outcome)) {
    // Failed Step only (passed ones keep theirs in the run directory); fileName carries the path to the console formatter.
    const shot = run.lastScreenshot;
    if (shot && existsSync(shot)) this.attach(readFileSync(shot), { mediaType: "image/png", fileName: shot });
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
  if (!worker) console.log(`\nRun directory: ${run.path} (log.txt has the full decision log)`);
  for (const { cassette: c } of deciders.values()) if (c) console.log(`Cassette ${c.path}: ${c.hits} replayed, ${c.recorded} recorded live`);
});

/** Infrastructure error (app not running, bad API key, network): one clear line, `--debug` for the stack. Exit code 2. */
function infra(err: unknown): Error {
  process.exitCode = 2;
  if (run) writeFileSync(join(run.path, INFRA), String((err as Error)?.message ?? err)); // read by `descisium run`
  if (opt("DEBUG")) return err as Error;
  const e = err as Error & { status?: number };
  const out = new Error(`${e.message.split("\n")[0]}${e.status === 401 ? " (check TYPESAFE_API_KEY in .env)" : ""}\nRerun with --debug for details.`);
  out.stack = out.message;
  return out;
}
