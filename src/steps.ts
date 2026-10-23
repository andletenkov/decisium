// cucumber-js support code (ADR 0003): one catch-all step definition runs every Step through Jev; hooks give each
// scenario a fresh browser, its run-directory folder, the feature's cassette and an empty memory.
// Options come from DECISIUM_* env (set by `decisium run`), so raw `npx cucumber-js` works too.
import { After, AfterAll, Before, BeforeAll, BeforeStep, defineStep, formatterHelpers, setDefaultTimeout, setParallelCanAssign, setWorldConstructor, Status, World } from "@cucumber/cucumber";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser } from "./browser.ts";
import { Cassette, RECORD_MODES, stepKey, type RecordMode } from "./cassette.ts";
import { executeStep, type StepReport } from "./execute.ts";
import { placeholders, stepArgument, stepKind, stepLabel, toUrl, urlFromTags, type StepArgument, type StepKind } from "./feature.ts";
import { JevDecider, MODEL, type Decider } from "./jev.ts";
import { placeholder } from "./observation.ts";
import { MARGINAL, NO_TRACE, outcomeMessage } from "./report.ts";
import { type Runtime } from "./runner.ts";
import { INFRA_MARKER, RunDir } from "./trace.ts";

const env = process.env;
const opt = (name: string) => env[`DECISIUM_${name}`] === "1";
const record = (env.DECISIUM_RECORD ?? "new") as RecordMode;

// Jev steps take seconds per Turn; the runner has its own caps (8 Turns, 5 s waits).
setDefaultTimeout(10 * 60_000);


// Parallel workers (`--parallel`) are separate processes: the CLI creates the run directory (DECISIUM_RUN_DIR) and an
// infrastructure error is signalled through a marker file in it, read by the CLI and by the other workers.
let run: RunDir;
const cliOwnsRun = !!env.DECISIUM_RUN_DIR; // the CLI prints the run directory once, not each worker
const broken = () => !!run && existsSync(join(run.path, INFRA_MARKER)); // after one, the remaining scenarios are skipped
const deciders = new Map<string, { cassette?: Cassette; live: Decider }>(); // per feature file

class Scenario extends World {
  browser!: Browser;
  rt!: Runtime;
  cassette?: Cassette;
  live!: Decider;
  key = ""; // the running Step in its cassette: scenario, position, text
  dir = "";
  kind: StepKind = "action";
  arg: StepArgument = {}; // the running Step's data table or doc string
  at = ""; // file:line of the running Step, in its trace event (scripts/cookbook.ts)
  earlier: Record<string, string> = {}; // memory: quoted value -> the Step that named it
}
setWorldConstructor(Scenario);

// A feature's scenarios run one after another (they share its cassette); different features run side by side.
setParallelCanAssign((pickle, running) => !running.some(p => p.uri === pickle.uri));

BeforeAll(function () {
  if (existsSync(".env")) process.loadEnvFile(".env"); // TYPESAFE_API_KEY; never logged
  if (!RECORD_MODES.includes(record)) throw new Error(`DECISIUM_RECORD must be one of ${RECORD_MODES.join(", ")}`);
  if (!env.TYPESAFE_API_KEY && (record !== "none" || opt("STEP") || opt("JUDGED"))) throw new Error("TYPESAFE_API_KEY is not set.");
  run = new RunDir("runs", env.DECISIUM_RUN_DIR || undefined);
  if (!cliOwnsRun) console.log(`Model: ${MODEL}\nRun directory: ${run.path}`);
});

Before(async function (this: Scenario, { pickle }) {
  if (broken()) return "skipped";
  const url = env.DECISIUM_URL || urlFromTags(pickle.tags);
  if (!url) throw infra(new Error(`No start URL for "${pickle.name}": pass --url or add an @url:<url> tag.`));
  try {
    if (!deciders.has(pickle.uri)) { // a corrupt cassette is a setup error, not a failed scenario
      const cassette = opt("STEP") ? undefined : new Cassette(pickle.uri.replace(/\.feature$/, "") + ".cassette.json", MODEL, record, run.path);
      deciders.set(pickle.uri, { cassette, live: new JevDecider() });
    }
  } catch (err) {
    throw infra(err);
  }
  ({ cassette: this.cassette, live: this.live } = deciders.get(pickle.uri)!);
  // Secret placeholders ("$NAME"): a missing variable is a setup error, not a failed Step (task 0030).
  const secrets: Record<string, string> = {};
  for (const token of pickle.steps.flatMap(s => placeholders({ text: s.text, ...stepArgument(s) }))) {
    const name = placeholder(token)!;
    if (!env[name]) throw infra(new Error(`"${token}" in "${pickle.name}": environment variable ${name} is not set (or empty).`));
    secrets[token] = env[name];
  }
  run.log(`\n=== Scenario: ${pickle.name}  (${url})`);
  this.dir = run.scenario(pickle.name);
  try {
    this.browser = await Browser.open(toUrl(url), opt("HEADED"), true, secrets); // fresh browser per scenario: no shared state
  } catch (err) {
    throw infra(err);
  }
  this.rt = run.runtime(this.browser);
});

BeforeStep(function (this: Scenario, { pickle, pickleStep, gherkinDocument }) {
  const line = formatterHelpers.GherkinDocumentParser.getGherkinStepMap(gherkinDocument)[pickleStep.astNodeIds[0]]?.location.line;
  this.at = `${pickle.uri}:${line}`;
  this.kind = stepKind(pickleStep);
  this.arg = stepArgument(pickleStep);
  const labels = pickle.steps.map(s => stepLabel({ text: s.text, kind: stepKind(s), ...stepArgument(s) }));
  this.key = stepKey(pickle.name, labels, pickle.steps.findIndex(s => s.id === pickleStep.id));
  Object.defineProperty(step, "length", { value: pickleStep.argument ? 2 : 1 });
});

// cucumber-js passes a data table or doc string as one more argument and checks the function's arity against it;
// the argument is read from the pickle step in BeforeStep instead, so the arity follows the Step (set there).
async function step(this: Scenario, text: string) {
  const log = (line: string) => { run.log(line); if (opt("VERBOSE")) console.log(line); };
  let r: StepReport;
  try {
    r = await executeStep(text, { rt: this.rt, live: this.live, cassette: this.cassette, key: this.key, kind: this.kind, arg: this.arg,
      earlier: this.earlier, log, trace: d => run.decider(d), judged: opt("JUDGED"), strict: opt("STRICT") });
  } catch (err) {
    throw infra(err);
  }
  run.event("step", { kind: this.kind, step: stepLabel({ text, kind: this.kind, ...this.arg }), at: this.at, ...r });
  if (r.outcome === "JUDGED_PASSED") this.log(`JUDGED_PASSED: judged by Jev (${r.reason})`);
  if (r.marginal) this.log(`${MARGINAL}${r.marginal}`); // read by the console formatter and the Qase reporter
  if (!["DONE", "PASSED", "JUDGED_PASSED"].includes(r.outcome)) {
    // Failed Step only; fileName carries the path to the console formatter.
    const shot = run.lastScreenshot;
    if (shot && existsSync(shot)) this.attach(readFileSync(shot), { mediaType: "image/png", fileName: shot });
    const err = new Error(outcomeMessage(r));
    err.stack = err.message; // no stack frames: the Qase reporter reads keywords in them
    throw err;
  }
}
defineStep(/^(.*)$/, step);

After(async function (this: Scenario, { result }) {
  run.flush(); // the scenario's whole log in one write
  if (!this.browser) return;
  const ok = result?.status === Status.PASSED;
  if (!ok) run.failure(this.browser.consoleErrors);
  // A passed scenario keeps its trace events but not its screenshots: a screenshot per Turn filled runs/ (2 GB).
  else for (const f of readdirSync(this.dir)) if (f.endsWith(".png")) rmSync(join(this.dir, f));
  if (!ok && this.browser.typedSecret) writeFileSync(join(this.dir, NO_TRACE), "The scenario typed a secret value; Playwright traces store typed text unmasked, so none is kept.\n");
  await this.browser.close(ok ? undefined : `${this.dir}/playwright-trace.zip`);
  run.event("result", { passed: ok });
  for (const { cassette } of deciders.values()) cassette?.save(); // per scenario, so a crash keeps what was recorded
  run.flush();
});

AfterAll(function () {
  if (!run) return;
  run.flush(); // a scenario skipped or broken before its browser opened
  if (!cliOwnsRun) run.done();
  if (!cliOwnsRun) console.log(`\nRun directory: ${run.path} (log.txt has the full decision log)`);
  for (const { cassette: c } of deciders.values()) if (c) console.log(`Cassette ${c.path}: ${c.replayed} replayed, ${c.recorded} recorded, ${c.healed} healed`);
});

/** Infrastructure error (app not running, bad API key, network): one clear line, `--debug` for the stack. Exit code 2. */
function infra(err: unknown): Error {
  process.exitCode = 2;
  if (run) writeFileSync(join(run.path, INFRA_MARKER), String((err as Error)?.message ?? err)); // read by `decisium run`
  if (opt("DEBUG")) return err as Error;
  const e = err as Error & { status?: number };
  const out = new Error(`${e.message.split("\n")[0]}${e.status === 401 ? " (check TYPESAFE_API_KEY in .env)" : ""}\nRerun with --debug for details.`);
  out.stack = out.message;
  return out;
}
