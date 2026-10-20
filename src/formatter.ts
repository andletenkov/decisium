// cucumber-js console formatter: one ✓/✗ line per Step, the reason under a failed one, and an end-of-run Failures block.
import { Formatter, formatterHelpers, Status, type IFormatterOptions } from "@cucumber/cucumber";
import type { Envelope } from "@cucumber/messages";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { stepKind, urlFromTags } from "./feature.ts";
import { failureReport, KIND, parseOutcome } from "./report.ts";

export default class DescisiumFormatter extends Formatter {
  static readonly documentation = "Descisium console output";

  constructor(options: IFormatterOptions) {
    super(options);
    const scenarios: { name: string; passed: boolean }[] = [];
    const failures: (() => string)[] = []; // built at the end: the Playwright trace is saved after the step
    options.eventBroadcaster.on("envelope", (e: Envelope) => {
      if (e.testCaseStarted) {
        const { pickle } = this.eventDataCollector.getTestCaseAttempt(e.testCaseStarted.id);
        this.log(`\n${pickle.name}  (${process.env.DESCISIUM_URL || urlFromTags(pickle.tags) || "no URL"})\n`);
      } else if (e.testStepFinished) {
        const { testCaseStartedId, testStepId, testStepResult: result } = e.testStepFinished;
        const { pickle, gherkinDocument, testCase, stepAttachments } = this.eventDataCollector.getTestCaseAttempt(testCaseStartedId);
        const step = pickle.steps.find(s => s.id === testCase.testSteps.find(t => t.id === testStepId)?.pickleStepId);
        const failed = result.status === Status.FAILED;
        if (!step) { // hook: only infrastructure errors (browser could not open, ...)
          if (failed) this.log(`  Error: ${result.message ?? "hook failed"}\n`);
          return;
        }
        if (![Status.PASSED, Status.FAILED].includes(result.status)) return; // skipped after a failure
        const kind = stepKind(step);
        const attachments = stepAttachments[testStepId] ?? [];
        const judged = attachments.some(a => a.body.startsWith("JUDGED_PASSED"));
        this.log(`  ${failed ? "✗" : "✓"} ${KIND[kind]}: ${step.text}${judged ? "  (judged by Jev)" : ""}\n`);
        if (!failed) return;
        const r = parseOutcome(result.message ?? "");
        this.log(`      ${r ? `${r.outcome}${r.reason ? `: ${r.reason}` : ""}` : `Error: ${result.message}`}`.replace(/\n/g, "\n      ") + "\n");
        if (!r) return;
        const line = formatterHelpers.GherkinDocumentParser.getGherkinStepMap(gherkinDocument)[step.astNodeIds[0]]?.location.line;
        const screenshot = attachments.findLast(a => a.mediaType === "image/png")?.fileName;
        const where = process.env.DESCISIUM_STEP === "1" ? "command line" : `${pickle.uri}:${line}`;
        failures.push(() => {
          const trace = screenshot && join(dirname(screenshot), "playwright-trace.zip");
          return failureReport(where, pickle.name, kind, step.text, r, screenshot, trace && existsSync(trace) ? trace : undefined);
        });
      } else if (e.testCaseFinished && !e.testCaseFinished.willBeRetried) {
        const { pickle, worstTestStepResult } = this.eventDataCollector.getTestCaseAttempt(e.testCaseFinished.testCaseStartedId);
        scenarios.push({ name: pickle.name, passed: worstTestStepResult.status === Status.PASSED });
      } else if (e.testRunFinished) {
        if (failures.length) this.log(`\n${"─".repeat(60)}\nFailures\n\n${failures.map(f => f()).join("\n\n")}\n`);
        const failed = scenarios.filter(s => !s.passed).map(s => s.name);
        this.log(`\n${scenarios.length - failed.length}/${scenarios.length} scenarios passed${failed.length ? `; failed: ${failed.join(", ")}` : ""}\n`);
      }
    });
  }
}
