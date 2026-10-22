// The official Qase reporter, plus marginal-pass warnings (task 0027) as the comment of a passed result: the reporter
// itself sets the comment only from failing Steps' messages.
import type { IFormatterOptions } from "@cucumber/cucumber";
import type { Envelope, TestCaseFinished } from "@cucumber/messages";
import CucumberQaseReporter from "cucumberjs-qase-reporter";
import { MARGINAL } from "./report.ts";

type Storage = { convertTestCase(f: TestCaseFinished): { execution: { status: string }; message: string | null } | undefined };

export default class DescisiumQaseReporter extends CucumberQaseReporter {
  constructor(options: IFormatterOptions) {
    super(options);
    const warnings = new Map<string, string[]>(); // testCaseStartedId -> marginal-pass warnings
    options.eventBroadcaster.on("envelope", ({ attachment: a }: Envelope) => {
      if (a?.testCaseStartedId && a.body.startsWith(MARGINAL)) warnings.set(a.testCaseStartedId, [...warnings.get(a.testCaseStartedId) ?? [], a.body]);
    });
    // shortcut: wraps the reporter's private storage (cucumberjs-qase-reporter 2.5); recheck on upgrade.
    const storage = (this as unknown as { storage: Storage }).storage;
    const convert = storage.convertTestCase.bind(storage);
    storage.convertTestCase = finished => {
      const result = convert(finished);
      const w = warnings.get(finished.testCaseStartedId);
      if (result && w && result.execution.status === "passed") result.message = w.join("\n");
      return result;
    };
  }
}
