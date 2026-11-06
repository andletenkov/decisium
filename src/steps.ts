// cucumber-js support code (ADR 0003): one catch-all step definition runs every Step through Jev; hooks give each
// scenario a fresh browser, its run-directory folder, the feature's cassette and an empty memory.
// Options come from worldParameters.decisium and DECISIUM_* env (src/options.ts), so raw `npx cucumber-js` works too.
import {
  After,
  AfterAll,
  AfterStep,
  Before,
  BeforeAll,
  BeforeStep,
  defineStep,
  formatterHelpers,
  setDefaultTimeout,
  setParallelCanAssign,
  setWorldConstructor,
  Status,
  supportCodeLibraryBuilder,
  World,
} from "@cucumber/cucumber";
import type { PickleStep } from "@cucumber/messages";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Browser } from "./browser.ts";
import { Cassette, RECORD_MODES, stepKey, type RecordMode } from "./cassette.ts";
import { executeStep, type StepReport } from "./execute.ts";
import { contextFromTags, fromPickle, ownTags, tagValue, toUrl, urlFromTags } from "./feature.ts";
import { forOrigin, SavedStorage, type StorageState } from "./saved.ts";
import { consumerChain, discoverStates, isStateFile, loadStates, type StateDef, type States } from "./states.ts";
import type { Decider } from "./decision.ts";
import { JevDecider, MODEL } from "./jev.ts";
import { MARGINAL, NO_TRACE, outcomeMessage } from "./report.ts";
import type { Runtime } from "./runner.ts";
import { placeholder, readStep, type StepArgument, type StepKind } from "./step.ts";
import { INFRA_MARKER, RunDir, SETUP_MARKER } from "./trace.ts";
import { applyOptions, settingWarnings } from "./options.ts";

// Issue 8: a client cucumber configuration importing decisium's steps from another path (source while the CLI uses
// dist) loads this module twice; the two catch-all definitions then defer to each other forever and the run collects
// 0 scenarios. Fail loudly instead.
const LOADED = Symbol.for("decisium.steps");
const loaded = globalThis as unknown as Record<symbol, string | undefined>;
if (loaded[LOADED] && loaded[LOADED] !== import.meta.url)
  throw new Error(
    `Decisium's step definitions are loaded twice (${loaded[LOADED]} and ${import.meta.url}): drop the decisium import from your cucumber configuration, "decisium run" adds it.`,
  );
loaded[LOADED] = import.meta.url;

const env = process.env;
const opt = (name: string) => env[`DECISIUM_${name}`] === "1";
let record: RecordMode; // set in BeforeAll, once worldParameters are known

// Jev steps take seconds per Turn; the runner has its own caps (maxTurns, checkTimeout, actionTimeout).
setDefaultTimeout(10 * 60_000);

// Parallel workers (`--parallel`) are separate processes: the CLI creates the run directory (DECISIUM_RUN_DIR) and an
// infrastructure error is signalled through a marker file in it, read by the CLI and by the other workers.
let run: RunDir;
const cliOwnsRun = !!env.DECISIUM_RUN_DIR; // the CLI prints the run directory once, not each worker
const broken = () => !!run && existsSync(join(run.path, INFRA_MARKER)); // after one, the remaining scenarios are skipped
const deciders = new Map<string, { cassette?: Cassette; live: Decider }>(); // per feature file
let states: States = new Map(); // `@state-def:` definitions (issue 11), loaded in BeforeAll
let saved: SavedStorage; // `@save:storage` states' saved storage, shared by the run's workers
let clientSteps: ReturnType<typeof supportCodeLibraryBuilder.finalize>["stepDefinitions"] = []; // the client's step definitions, for state Steps they match

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
  /** Public API for client step definitions (task 0048): the current tab (a popup becomes it) and its Playwright context. */
  get page() {
    return this.browser.page;
  }
  get context() {
    return this.browser.context;
  }
}
setWorldConstructor(Scenario);

// A feature's scenarios run one after another (they share its cassette); different features run side by side.
setParallelCanAssign((pickle, running) => !running.some((p) => p.uri === pickle.uri));

BeforeAll(function () {
  if (existsSync(".env")) process.loadEnvFile(".env"); // TYPESAFE_API_KEY; never logged
  const settings = applyOptions(this.parameters.decisium);
  record = (env.DECISIUM_RECORD || "new") as RecordMode;
  if (!RECORD_MODES.includes(record)) throw new Error(`DECISIUM_RECORD must be one of ${RECORD_MODES.join(", ")}`);
  if (!env.TYPESAFE_API_KEY && (record !== "none" || opt("STEP") || opt("JUDGED")))
    throw new Error("TYPESAFE_API_KEY is not set.");
  run = new RunDir(settings.reportDir, env.DECISIUM_RUN_DIR || undefined);
  saved = new SavedStorage(run.path);
  states = loadStates(discoverStates(env.DECISIUM_STATES || undefined));
  if (cliOwnsRun) return; // the CLI warned and wrote the run event
  run.event("run", { settings });
  if (!env.CUCUMBER_WORKER_ID || env.CUCUMBER_WORKER_ID === "0")
    for (const w of settingWarnings(settings)) console.warn(w);
  console.log(`Model: ${MODEL}\nRun directory: ${run.path}`);
});

// Its own timeout: live state Steps run inside it, and a worker may wait for another to save a state's storage.
Before({ timeout: 30 * 60_000 }, async function (this: Scenario, { pickle, gherkinDocument }) {
  if (broken()) return "skipped";
  if (isStateFile(pickle.uri))
    throw infra(new Error(`${pickle.uri} is a state definition file; exclude it from test paths`));
  let chain: StateDef[];
  try {
    chain = consumerChain(states, {
      name: pickle.name,
      tags: pickle.tags.map((t) => t.name),
      own: ownTags(gherkinDocument, pickle),
    });
  } catch (err) {
    throw infra(err);
  }
  // A state runs from the @url: of the root of its chain; the scenario continues where it ended.
  const url = env.DECISIUM_URL || (chain.length ? chain[0].url : urlFromTags(pickle.tags));
  if (!url) throw infra(new Error(`No start URL for "${pickle.name}": pass --url or add an @url:<url> tag.`));
  try {
    if (!deciders.has(pickle.uri)) {
      // a corrupt cassette is a setup error, not a failed scenario
      const cassette = opt("STEP")
        ? undefined
        : new Cassette(pickle.uri.replace(/\.feature$/, "") + ".cassette.json", MODEL, record, run.path);
      deciders.set(pickle.uri, { cassette, live: new JevDecider() });
    }
  } catch (err) {
    throw infra(err);
  }
  ({ cassette: this.cassette, live: this.live } = deciders.get(pickle.uri)!);
  // Secret placeholders ("$NAME"): a missing variable is a setup error, not a failed Step (task 0030).
  const secrets: Record<string, string> = {};
  const tokens = [
    ...chain.flatMap((d) => d.steps.flatMap((s) => readStep(s).placeholders.map((t) => [t, `state "${d.name}"`]))),
    ...pickle.steps.flatMap((s) => readStep(fromPickle(s)).placeholders.map((t) => [t, `"${pickle.name}"`])),
  ];
  for (const [token, where] of tokens) {
    const name = placeholder(token)!;
    if (!env[name])
      throw infra(new Error(`"${token}" in ${where}: environment variable ${name} is not set (or empty).`));
    secrets[token] = env[name];
  }
  run.log(`\n=== Scenario: ${pickle.name}  (${url})`);
  this.dir = run.scenario(pickle.name);
  const glob = tagValue(pickle.tags, "replay-network");
  // One recording per scenario: replay matches the n-th call to a URL. Outline rows share a name, so the last row's wins.
  const har = `${pickle.uri.replace(/\.feature$/, "")}.network/${pickle.name.replace(/[^\w-]+/g, "_")}.har`;
  // Follows --record: all re-records, none replays, new replays an existing recording and records a missing one.
  const network = glob
    ? {
        glob,
        har,
        mode: record === "all" || (record === "new" && !existsSync(har)) ? ("record" as const) : ("replay" as const),
      }
    : undefined;
  const open = async (storageState?: StorageState) => {
    try {
      this.browser = await Browser.open(
        toUrl(url),
        opt("HEADED"),
        true,
        secrets,
        dirname(pickle.uri),
        this.dir, // fresh browser per scenario: no shared state
        { ...contextFromTags(pickle.tags), storageState },
        network,
      );
    } catch (err) {
      throw infra(err);
    }
    // Live session cookies: no Playwright trace is kept, as for a typed secret.
    if (storageState) this.browser.typedSecret = true;
    this.browser.replay = record === "none";
    this.rt = run.runtime(this.browser);
    networkMissed(this.browser);
  };
  if (!chain.some((d) => d.save)) {
    await open();
    for (const def of chain) await runState(this, def, def.steps);
    return;
  }
  // @save:storage: start from the latest saved state in the chain, replay the rest, save what this scenario reached first.
  for (let attempt = 0; ; attempt++) {
    let plan: Awaited<ReturnType<SavedStorage["plan"]>>;
    try {
      plan = await saved.plan(chain);
    } catch (err) {
      throw infra(err);
    }
    const loaded = plan.load === undefined ? undefined : chain[plan.load];
    await open(loaded && saved.read(loaded.name));
    if (loaded) {
      // Re-run its final check: a half-restored or expired session replays the Steps instead.
      run.log(`--- state ${loaded.name}: loaded saved storage`);
      const check = await runState(this, loaded, loaded.steps.slice(-1), true);
      if (!check) {
        if (attempt >= 2)
          throw setupError(new Error(`state "${loaded.name}" fails its check after loading and replaying`));
        run.log(`--- state ${loaded.name}: check failed after loading; replaying its Steps`);
        saved.forget(loaded.name);
        saved.release();
        await this.browser.close();
        continue;
      }
    }
    for (const def of chain.slice((plan.load ?? -1) + 1)) {
      await runState(this, def, def.steps);
      if (plan.mine.includes(def.name))
        saved.write(def.name, forOrigin(await this.browser.context.storageState(), toUrl(url)));
    }
    return;
  }
});

/**
 * Runs a state's Steps before the scenario's, keyed `state:<name>: <label>` in the consumer's cassette. A failing Step
 * is a setup error (exit 2), labelled with the state and its line. `quiet`: return false on failure instead.
 */
async function runState(w: Scenario, def: StateDef, steps: StateDef["steps"], quiet = false): Promise<boolean> {
  const labels = def.steps.map((s) => readStep(s).label);
  if (!quiet) run.log(`--- state ${def.name} (${def.file}:${def.line})`);
  const started = Date.now();
  for (const s of steps) {
    const { text, kind, line, ...arg } = s;
    w.kind = kind;
    w.arg = arg;
    w.at = `${def.file}:${line}`;
    w.key = stepKey(`state:${def.name}`, labels, def.steps.indexOf(s));
    try {
      const client = clientSteps.find((d) => d.matchesStepName(text));
      if (client) {
        const argument = arg.table
          ? { dataTable: { rows: arg.table.map((r) => ({ cells: r.map((value) => ({ value })) })) } }
          : arg.docString !== undefined
            ? { docString: { content: arg.docString } }
            : undefined;
        const { parameters } = await client.getInvocationParameters({
          step: { text, argument } as unknown as PickleStep,
          world: w,
        } as unknown as Parameters<typeof client.getInvocationParameters>[0]);
        const t = Date.now();
        await client.code.apply(w, parameters);
        run.event("step", {
          kind,
          step: readStep(s).label,
          at: w.at,
          outcome: "DONE",
          client: true,
          ms: Date.now() - t,
        });
      } else await perform(w, text, quiet);
      networkMissed(w.browser);
    } catch (err) {
      if (quiet) return false;
      throw setupError(new Error(`in state "${def.name}" at ${w.at}: ${(err as Error).message.split("\n")[0]}`));
    }
  }
  run.event("state", { state: def.name, steps: steps.length, ms: Date.now() - started }); // the cost of each state
  return true;
}

/** Fails the Step (or the page load) that made a `@replay-network` request the recording does not have. */
function networkMissed(browser?: Browser) {
  const missed = browser?.networkMisses.splice(0);
  if (missed?.length) {
    const err = new Error(`network not in recording: ${missed.join(", ")} (re-record with --record all)`);
    err.stack = err.message;
    throw err;
  }
}
AfterStep(function (this: Scenario) {
  networkMissed(this.browser);
});

BeforeStep(function (this: Scenario, { pickle, pickleStep, gherkinDocument }) {
  const line =
    formatterHelpers.GherkinDocumentParser.getGherkinStepMap(gherkinDocument)[pickleStep.astNodeIds[0]]?.location.line;
  this.at = `${pickle.uri}:${line}`;
  const { kind, text: _, ...arg } = fromPickle(pickleStep);
  this.kind = kind;
  this.arg = arg;
  const labels = pickle.steps.map((s) => readStep(fromPickle(s)).label);
  this.key = stepKey(
    pickle.name,
    labels,
    pickle.steps.findIndex((s) => s.id === pickleStep.id),
  );
  Object.defineProperty(step, "length", { value: pickleStep.argument ? 2 : 1 });
});

// cucumber-js passes a data table or doc string as one more argument and checks the function's arity against it;
// the argument is read from the pickle step in BeforeStep instead, so the arity follows the Step (set there).
async function step(this: Scenario, text: string) {
  await perform(this, text);
}

/** Runs one Step through Jev (or its cassette); throws on a failed outcome, with the screenshot attached. */
async function perform(w: Scenario, text: string, quiet = false) {
  const log = (line: string) => {
    run.log(line);
    if (opt("VERBOSE")) console.log(line);
  };
  let r: StepReport;
  try {
    r = await executeStep(text, {
      rt: w.rt,
      live: w.live,
      cassette: w.cassette,
      key: w.key,
      kind: w.kind,
      arg: w.arg,
      earlier: w.earlier,
      log,
      trace: (d) => run.decider(d),
      judged: opt("JUDGED"),
      strict: opt("STRICT"),
    });
  } catch (err) {
    throw infra(err);
  }
  const ok = ["DONE", "PASSED", "JUDGED_PASSED"].includes(r.outcome);
  // quiet: a saved state's check after loading; a failure there replays the state, it is not a failed Step.
  if (quiet && !ok) {
    run.log(`  (check after loading: ${r.outcome})`);
    throw new Error(r.outcome);
  }
  run.event("step", {
    kind: w.kind,
    step: readStep({ text, kind: w.kind, ...w.arg }).label,
    at: w.at,
    ...r,
  });
  if (r.outcome === "JUDGED_PASSED") w.log(`JUDGED_PASSED: judged by Jev (${r.reason})`);
  // A file attachment any reporter keeps (text/plain opens as .txt); the console formatter reads it by its prefix.
  if (r.marginal) w.attach(`${MARGINAL}${r.marginal}`, { mediaType: "text/plain", fileName: "marginal-pass.txt" });
  if (!ok) {
    // Failed Step only; fileName carries the path to the console formatter.
    if (w.browser?.replay) await run.shoot(w.browser);
    const shot = run.lastScreenshot;
    if (shot && existsSync(shot)) w.attach(readFileSync(shot), { mediaType: "image/png", fileName: shot });
    const err = new Error(outcomeMessage(r));
    err.stack = err.message; // no stack frames: reporters such as Qase's read keywords in them
    throw err;
  }
}
const CATCH_ALL = /^(.*)$/;
defineStep(CATCH_ALL, step);

// Client step definitions (task 0048): a line another definition matches runs that one, not Jev. Without this cucumber
// reports it Ambiguous. Relies on cucumber internals (finalize, expression.match); "client steps" in test/decisium.test.ts
// fails when they change.
const finalize = supportCodeLibraryBuilder.finalize.bind(supportCodeLibraryBuilder);
supportCodeLibraryBuilder.finalize = (canonicalIds) => {
  const lib = finalize(canonicalIds);
  const ours = lib.stepDefinitions.find((d) => d.pattern === CATCH_ALL)!;
  const others = lib.stepDefinitions.filter((d) => d !== ours);
  clientSteps = others;
  const match = ours.expression.match.bind(ours.expression);
  ours.expression.match = (text) => (others.some((d) => d.matchesStepName(text)) ? null : match(text));
  return lib;
};

After(async function (this: Scenario, { result }) {
  run.flush(); // the scenario's whole log in one write
  saved?.release(); // a scenario that failed before saving its state's storage lets the next one replay it
  if (!this.browser) return;
  const ok = result?.status === Status.PASSED;
  if (!ok) run.failure(this.browser.consoleErrors);
  // A passed scenario keeps its trace events but not its screenshots: a screenshot per Turn filled runs/ (2 GB).
  else for (const f of readdirSync(this.dir)) if (f.endsWith(".png")) rmSync(join(this.dir, f));
  if (!ok && this.browser.typedSecret)
    writeFileSync(
      join(this.dir, NO_TRACE),
      "The scenario typed a secret value; Playwright traces store typed text unmasked, so none is kept.\n",
    );
  await this.browser.close(ok ? undefined : `${this.dir}/playwright-trace.zip`);
  run.event("result", { passed: ok, perf: this.browser.perf });
  for (const { cassette } of deciders.values()) cassette?.save(); // per scenario, so a crash keeps what was recorded
  run.flush();
});

AfterAll(() => {
  if (!run) return;
  run.flush(); // a scenario skipped or broken before its browser opened
  if (!cliOwnsRun) run.done();
  if (!cliOwnsRun) saved?.remove(); // run-scoped: the CLI removes it after every worker is done
  if (!cliOwnsRun) console.log(`\nRun directory: ${run.path} (log.txt has the full decision log)`);
  for (const { cassette: c } of deciders.values())
    if (c) console.log(`Cassette ${c.path}: ${c.replayed} replayed, ${c.recorded} recorded, ${c.healed} healed`);
});

/** A failed state: the scenario is a setup error (exit 2), not a failed test; unlike `infra`, the suite goes on. */
function setupError(err: Error): Error {
  process.exitCode = 2;
  if (run) writeFileSync(join(run.path, SETUP_MARKER), err.message); // read by `decisium run`, as workers exit alone
  err.stack = err.message;
  return err;
}

/** Infrastructure error (app not running, bad API key, network): one clear line, `--debug` for the stack. Exit code 2. */
function infra(err: unknown): Error {
  process.exitCode = 2;
  if (run) writeFileSync(join(run.path, INFRA_MARKER), String((err as Error)?.message ?? err)); // read by `decisium run`
  if (opt("DEBUG")) return err as Error;
  const e = err as Error & { status?: number };
  const out = new Error(
    `${e.message.split("\n")[0]}${e.status === 401 ? " (check TYPESAFE_API_KEY in .env)" : ""}\nRerun with --debug for details.`,
  );
  out.stack = out.message;
  return out;
}
