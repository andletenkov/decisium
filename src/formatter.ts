// cucumber-js console formatter: one ✓/✗ line per Step, the reason under a failed one, and an end-of-run Failures block.
import { Formatter, formatterHelpers, Status, type IFormatterOptions } from "@cucumber/cucumber";
import type { Envelope } from "@cucumber/messages";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fromPickle, urlFromTags } from "./feature.ts";
import { readStep } from "./step.ts";
import { agentReport, failureReport, KIND, MARGINAL, MARGINAL_HINT, NO_TRACE, parseOutcome, stepEvents, type AgentFailure, type TraceEvent } from "./report.ts";

const env = process.env;
/** Shell-quoted for a copy-paste command line. */
const q = (s: string) => /^[\w./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
/** The command that reruns one scenario (or the one command-line Step) with this run's options. */
function rerun(target: string[]): string {
  const cli = relative(process.cwd(), fileURLToPath(import.meta.resolve(`./cli${import.meta.url.slice(-3)}`)));
  const flags = [env.DECISIUM_URL && `--url ${q(env.DECISIUM_URL)}`, env.DECISIUM_JUDGED === "1" && "--judged", env.DECISIUM_STRICT === "1" && "--strict"];
  return ["node", cli, ...target.map(q), ...flags].filter(Boolean).join(" ");
}

export default class DecisiumFormatter extends Formatter {
  static readonly documentation = "Decisium console output";

  constructor(options: IFormatterOptions) {
    super(options);
    const scenarios: { name: string; passed: boolean }[] = [];
    const failures: (() => Omit<AgentFailure, "events">)[] = []; // built at the end: the Playwright trace is saved after the step
    const warnings: string[] = [];
    const hookIds = new Map<string, string>(); // testRunHookStarted id -> hook definition id
    const hookFailures: string[] = []; // a failed BeforeAll/AfterAll (e.g. no TYPESAFE_API_KEY): cucumber runs no scenario
    options.eventBroadcaster.on("envelope", (e: Envelope) => {
      if (e.testCaseStarted) {
        const { pickle } = this.eventDataCollector.getTestCaseAttempt(e.testCaseStarted.id);
        this.log(`\n${pickle.name}  (${process.env.DECISIUM_URL || urlFromTags(pickle.tags) || "no URL"})\n`);
      } else if (e.testStepFinished) {
        const { testCaseStartedId, testStepId, testStepResult: result } = e.testStepFinished;
        const { pickle, gherkinDocument, testCase, stepAttachments } = this.eventDataCollector.getTestCaseAttempt(testCaseStartedId);
        const step = pickle.steps.find(s => s.id === testCase.testSteps.find(t => t.id === testStepId)?.pickleStepId);
        const failed = result.status === Status.FAILED;
        if (!step) { // hook: only infrastructure errors (browser could not open, ...)
          if (failed) this.log(`  Error: ${result.message ?? "hook failed"}\n`);
          return;
        }
        if (result.status === Status.UNDEFINED) { // no Decisium step definitions loaded (a wrong "import" path)
          this.log(`  ? Step: ${step.text}\n  no step definition: is Decisium's steps file in "import"?\n`);
          return;
        }
        if (![Status.PASSED, Status.FAILED].includes(result.status)) return; // skipped after a failure
        const parsed = fromPickle(step);
        const { kind } = parsed;
        const label = readStep(parsed).label; // with its table or doc string
        const attachments = stepAttachments[testStepId] ?? [];
        const judged = attachments.some(a => a.body.startsWith("JUDGED_PASSED"));
        this.log(`  ${failed ? "✗" : "✓"} ${KIND[kind]}: ${label}${judged ? "  (judged by Jev)" : ""}\n`);
        const marginal = attachments.find(a => a.body.startsWith(MARGINAL))?.body.slice(MARGINAL.length);
        if (marginal) {
          this.log(`      ⚠ marginal pass: ${marginal}\n`);
          warnings.push(`⚠ ${pickle.name}\n  ${KIND[kind]}: ${label}\n  Jev was barely confident: ${marginal}`);
        }
        if (!failed) return;
        const r = parseOutcome(result.message ?? "");
        this.log(`      ${r ? `${r.outcome}${r.reason ? `: ${r.reason}` : ""}` : `Error: ${result.message}`}`.replace(/\n/g, "\n      ") + "\n");
        if (!r) return;
        const line = formatterHelpers.GherkinDocumentParser.getGherkinStepMap(gherkinDocument)[step.astNodeIds[0]]?.location.line;
        const screenshot = attachments.findLast(a => a.mediaType === "image/png")?.fileName;
        const cmdLine = env.DECISIUM_STEP === "1";
        const where = cmdLine ? "command line" : `${pickle.uri}:${line}`;
        // The scenario's own line; for an Outline, its Examples row (the last AST node).
        const scenarioLine = formatterHelpers.GherkinDocumentParser.getGherkinScenarioLocationMap(gherkinDocument)[pickle.astNodeIds.at(-1)!]?.line;
        failures.push(() => {
          const trace = screenshot && join(dirname(screenshot), "playwright-trace.zip");
          const ui = screenshot && join(dirname(screenshot), "ui.txt");
          const noTrace = screenshot && join(dirname(screenshot), NO_TRACE);
          return {
            where, scenario: pickle.name, kind, step: label, ...r, screenshot,
            trace: trace && existsSync(trace) ? trace : noTrace && existsSync(noTrace) ? `not kept: ${readFileSync(noTrace, "utf8").trim()}` : undefined, ui: ui && existsSync(ui) ? ui : undefined,
            rerun: rerun(cmdLine ? ["step", step.text] : ["run", `${pickle.uri}:${scenarioLine}`]),
          };
        });
      } else if (e.testCaseFinished && !e.testCaseFinished.willBeRetried) {
        const { pickle, worstTestStepResult } = this.eventDataCollector.getTestCaseAttempt(e.testCaseFinished.testCaseStartedId);
        scenarios.push({ name: pickle.name, passed: worstTestStepResult.status === Status.PASSED });
      } else if (e.testRunHookStarted) {
        hookIds.set(e.testRunHookStarted.id, e.testRunHookStarted.hookId);
      } else if (e.testRunHookFinished?.result.status === Status.FAILED) {
        const before = this.supportCodeLibrary.beforeTestRunHookDefinitions.some(h => h.id === hookIds.get(e.testRunHookFinished!.testRunHookStartedId));
        const { message, exception } = e.testRunHookFinished.result;
        hookFailures.push(`✗ ${before ? "BeforeAll" : "AfterAll"} hook failed\n  ${(exception?.message ?? message ?? "").split("\n")[0]}`);
      } else if (e.testRunFinished) {
        if (hookFailures.length) this.log(`\n${hookFailures.join("\n")}\n`);
        const failed = failures.map(f => f());
        if (failed.length) this.log(`\n${"─".repeat(60)}\nFailures\n\n${failed.map(f => failureReport(f.where, f.scenario, f.kind, f.step, f, f.screenshot, f.trace)).join("\n\n")}\n`);
        if (warnings.length) this.log(`\n${"─".repeat(60)}\nMarginal passes\n\n${warnings.join("\n\n")}\n\nWhat to do: ${MARGINAL_HINT}\n`);
        const failedNames = scenarios.filter(s => !s.passed).map(s => s.name);
        if (!scenarios.length && hookFailures.length) return;
        this.log(`\n${scenarios.length - failedNames.length}/${scenarios.length} scenarios passed${failedNames.length ? `; failed: ${failedNames.join(", ")}` : ""}\n`);
        // The run directory: the CLI's, or (raw cucumber-js) the one the screenshots are in.
        const shot = failed.find(f => f.screenshot)?.screenshot;
        const runDir = env.DECISIUM_RUN_DIR || (shot && dirname(dirname(shot)));
        if (failed.length && runDir && env.DECISIUM_NO_AGENT_REPORT !== "1") {
          const tracePath = join(runDir, "trace.jsonl");
          const events: TraceEvent[] = existsSync(tracePath) ? readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
          const path = join(runDir, "report.md");
          writeFileSync(path, agentReport(failed.map(f => ({ ...f, events: stepEvents(events, f.scenario, f.step) }))));
          this.log(`Agent report: ${path}\n`);
        }
      }
    });
  }
}
