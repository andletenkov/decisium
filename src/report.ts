// How Step outcomes are worded for people (console) and for Qase, whose reporter picks `failed` vs `invalid`
// from keywords in the error message (qase-javascript-commons determineTestStatus).
import type { StepKind } from "./feature.ts";

/** Outcomes that mean the app is wrong (Qase `failed`); every other non-passing outcome is `invalid` (the test could not decide). */
const FAILED = ["ASSERTION_FAILED", "JUDGED_FAILED", "BLOCKED", "ACTION_FAILED"];

/** What to do about each failure outcome, shown under the reason. */
export const HINTS: Record<string, string> = {
  AMBIGUOUS: "Jev was not confident enough to decide. Make the step more specific: name the element or area (e.g. \"in the campaign list\").",
  UNVERIFIABLE: "Code cannot check this as written. Quote the exact text or value you expect.",
  ASSERTION_FAILED: "The page does not show what the check expects. Compare with the screenshot; if the app is right, update the step.",
  BLOCKED: "The control needed for this step is not on the screen. Check the screenshot: a previous step may have gone somewhere else, or a step to navigate is missing.",
  ELEMENT_NOT_FOUND: "The page changed while deciding. Rerun; if it repeats, the page may be re-rendering constantly.",
  ACTION_FAILED: "The browser could not perform the action (hidden, disabled or covered element). See the Playwright trace and console errors.",
  STEP_TIMEOUT: "The step needed more than 8 actions. Split it into smaller steps.",
  UI_CHANGED: "The run replays recorded Jev answers (cassette) and this step has none that fits. If the change is intended, rerun with --record new to record just the changed steps (calls Jev), or --record all to re-record everything.",
  JUDGED_FAILED: "Jev judged that the page does not satisfy the check.",
};
export const KIND: Record<StepKind, string> = { action: "Step", attempt: "Attempt", assertion: "Check" };

// Substrings the reporter reads as "assertion" (=> failed). Kept out of `invalid` messages with an invisible word joiner.
const ASSERTION_WORDS = /expect|assert|matcher|objectcontaining|actual|to (?:be|equal|contain|match|throw|have been called)|test failed/gi;
const JOINER = "\u2060";
const TAG = / \(test failed\)(?=:|$)/;

const HINT = /\n\nWhat to do: [\s\S]*$/;

/**
 * The error message a failing Step throws: starts with the outcome, ends with what to do (Qase shows only this message).
 * `failed` outcomes carry "test failed".
 */
export function outcomeMessage({ outcome, reason }: { outcome: string; reason?: string }): string {
  const body = `${reason ? `: ${reason}` : ""}${HINTS[outcome] ? `\n\nWhat to do: ${HINTS[outcome]}` : ""}`;
  if (FAILED.includes(outcome)) return `${outcome} (test failed)${body}`;
  return outcome + body.replace(ASSERTION_WORDS, w => w[0] + JOINER + w.slice(1));
}

/** Inverse of outcomeMessage; undefined for other errors (infrastructure, bugs). */
export function parseOutcome(message: string): { outcome: string; reason: string } | undefined {
  const m = /^([A-Z_]+)(?::\s([\s\S]*))?$/.exec(message.replace(HINT, "").replace(TAG, ""));
  if (!m || !(FAILED.includes(m[1]) || m[1] in HINTS)) return undefined;
  return { outcome: m[1], reason: (m[2] ?? "").replaceAll(JOINER, "") };
}

/** A failure in plain words: where, what, why, what to do, and where to look. */
export function failureReport(where: string, scenario: string, kind: StepKind, step: string, r: { outcome: string; reason?: string }, screenshot?: string, trace?: string): string {
  return [
    `✗ ${scenario}`,
    `  at ${where}  ${KIND[kind]}: ${step}`,
    `  ${r.outcome}${r.reason ? `: ${r.reason}` : ""}`,
    HINTS[r.outcome] && `  What to do: ${HINTS[r.outcome]}`,
    screenshot && `  Screenshot: ${screenshot}`,
    trace && `  Playwright trace: npx playwright show-trace ${trace}`,
  ].filter(Boolean).join("\n");
}
