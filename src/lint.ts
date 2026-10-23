// `decisium lint <file.feature>`: what each Step will be taken as, read without a browser or Jev (task 0031).
// Per Step: its kind, the quoted values Jev can pick from, the keys it presses, secret placeholders, and warnings for wordings that
// docs/cookbook.md shows failing.
import { readFileSync } from "node:fs";
import { hasHeader, parseFeature, placeholders, quotedValues, stepLabel, tableSteps, type ParsedStep } from "./feature.ts";
import { KIND } from "./report.ts";
import { placeholder, quoted, stepKeys, stepValues } from "./observation.ts";

const SEE = "see docs/cookbook.md";

/** Cookbook warnings for one Step. `before`: the scenario's earlier Steps. */
export function warnings(step: ParsedStep, before: ParsedStep[], env: Record<string, string | undefined> = process.env): string[] {
  const t = step.text;
  const earlier = before.flatMap(s => quoted(s.text)).filter(v => !placeholder(v));
  const values = quotedValues(step);
  const out: string[] = [];
  for (const name of new Set(placeholders(step).map(v => placeholder(v)!))) {
    if (!env[name]) out.push(`$${name} is not set in this environment: the run stops before it starts (exit 2)`);
  }
  const secret = /\b(?:password|passcode|token|secret|api key)\b[^"“]*["“]([^"”]+)["”]/i.exec(t)?.[1];
  if (secret && !placeholder(secret) && step.kind !== "assertion") {
    out.push(`a literal value next to "password/token/secret" is sent to Jev and written to the cassette and logs; write "$NAME" and set it in the environment (${SEE}, Secrets)`);
  }
  if (step.kind !== "assertion") {
    if (/\bsearch(es)? (for|the)\b/i.test(t) && !/\b(open|opens|submit|submits)\b/i.test(t)) {
      out.push(`"search for" runs a search but does not open a result, and Jev may count typing alone as done; say "I open the "X" ... through the search", or add "and submit the search" (${SEE}, Navigate)`);
    }
    if (/^(I\s+)?(un)?(check|tick)\b/i.test(t) && /\b(and|then)\b|,/i.test(t)) out.push(`checking a box is decided by code only when the Step does nothing else; split "and ..." into its own Step (${SEE}, Submit and act)`);
    for (const name of stepKeys(t).unknown) out.push(`"${name}" is not a key name, so it is never pressed; use Escape, Tab, ArrowDown, PageDown, Home, F2, Esc, down arrow, Space, Ctrl+K... (${SEE}, Keys)`);
    if (!/\b(press(es|ed|ing)?|hit(s|ting)?)\b/i.test(t) && /\b(Esc|Escape)\b|\b(Tab|Enter|Return|Space|Backspace|Delete|Home|End|arrow|F\d+) key\b|\b(Ctrl|Control|Shift|Alt|Cmd|Meta)\s*\+\s*\w/i.test(t)) out.push(`names a key without "press" or "hit", so no key is offered: say "press Escape" (${SEE}, Keys)`);
    if (/^(I\s+)?(accept|dismiss|cancel|answer|confirm)\s+(the\s+)?(alert|confirm|confirmation|prompt|browser dialog)\b/i.test(t)) out.push(`a browser dialog is answered by the Step that opens it and dismissed when that Step ends, so this Step finds none open; say the intent in the Step that opens it ("I delete the note", "I start deleting the note but cancel") (${SEE}, Browser dialogs)`);
    if (step.table && hasHeader("action", step.table) && step.table.length < 2) out.push(`an action's table with 3+ columns starts with its header row, so this one has no row to act on: AMBIGUOUS; add one row per entry under the header (${SEE}, Data tables)`);
    return out;
  }
  // Checks. A table is matched by code, row by row under its header; a header alone compares nothing.
  if (step.table) {
    if (hasHeader("assertion", step.table) && step.table.length < 2) out.push(`a check's table with 2+ columns starts with its header row, so this one has no row to compare: UNVERIFIABLE; add a header row naming the page table's columns (${SEE}, Data tables)`);
    return out;
  }
  // Checks. A state check ("should be disabled") needs no quoted value.
  const state = /\bshould (?:not )?be (disabled|enabled|checked|unchecked|expanded|collapsed|selected|unselected|pressed|unpressed)\b/i.test(t);
  const subjective = !values.length && /\b(well|nicely|good|nice|tidy|clean|readable|beautiful|professional|properly|correctly|looks?)\b/i.test(t);
  if (!values.length && !state && !subjective) {
    out.push(earlier.length
      ? `quotes nothing: Jev must work out which earlier value it means (${[...new Set(earlier)].map(v => `"${v}"`).join(", ")}); if it is unsure the check is UNVERIFIABLE, so quote the value when there are several (${SEE}, Memory)`
      : `quotes nothing for code to compare: UNVERIFIABLE; quote the expected text or value (${SEE}, Presence)`);
  }
  if (values.length > 1 && /\bshould (be|say|show|read|equal)\b(?! (shown|visible|displayed|listed))/i.test(t)) {
    out.push(`a value check compares exactly one quoted value; with ${values.length} it is UNVERIFIABLE (split it into one check per value) (${SEE}, Value checks)`);
  }
  if (/\btitle\b/i.test(t) && !/\b(page|tab|browser|window) title\b/i.test(t)) {
    out.push(`"title" also names the browser tab's title, so Jev may be unsure which one you mean (AMBIGUOUS); say "heading" (${SEE}, Value checks)`);
  }
  if (subjective) {
    out.push(`reads as subjective: code cannot compare it (UNVERIFIABLE) unless the run has --judged; quote something concrete (${SEE}, Value checks)`);
  }
  const AREA = "(?:[\\w-]+ ){0,3}(?:list|calendar|table|results|menu|section|dialog|sidebar|panel|grid|cart|tab|form|header|footer|toolbar|campaigns)";
  // "... in the campaign list", or the area as subject: "the campaign list should contain ...".
  const area = new RegExp(`\\b(?:in|on|inside|within|among|under) (?:the |a )?(${AREA})\\b`, "i").exec(t)
    ?? new RegExp(`^(?:the )?(${AREA}) should (?:not )?(?:contain|include|list|show)\\b`, "i").exec(t);
  // The cookbook's failing pattern: the last action opened something else (a campaign), and the check names an area
  // (the campaign list) that is therefore not on the screen.
  const lastAction = before.findLast(s => s.kind !== "assertion")?.text ?? "";
  const noun = area?.[1].split(" ").at(-1)!;
  if (area && /\bopen/i.test(lastAction) && !new RegExp(`\\b${noun}`, "i").test(lastAction)) out.push(`looks only in "${area[1]}", but the Step before opened something else: if that area is not on the screen, the check is AMBIGUOUS; open it first (${SEE}, Scoped presence)`);
  return out;
}

/** The explanation of one feature file, for people. */
export function lint(path: string, env: Record<string, string | undefined> = process.env): string {
  const out = [path];
  let flagged = 0;
  for (const s of parseFeature(readFileSync(path, "utf8"), path)) {
    out.push("", `  Scenario: ${s.name}${s.url ? `  (${s.url})` : ""}`);
    const before: ParsedStep[] = [];
    for (const step of s.steps) {
      const values = step.kind === "assertion" ? quoted(step.text) : stepValues(step.text);
      const secrets = [...new Set(placeholders(step))];
      out.push(`  ${String(step.line ?? "").padStart(4)}  ${KIND[step.kind].padEnd(7)} ${stepLabel(step)}`);
      if (step.table && step.kind !== "assertion") for (const row of tableSteps(step.text, step.table)) out.push(`${" ".repeat(15)}row: ${row}`);
      const shown = values.filter(v => !placeholder(v));
      if (shown.length) out.push(`${" ".repeat(15)}${step.kind === "assertion" ? "compares" : "values"}: ${shown.map(v => `"${v}"`).join(", ")}`);
      const keys = step.kind === "assertion" ? [] : stepKeys(step.text).keys;
      if (keys.length) out.push(`${" ".repeat(15)}keys: ${keys.join(", ")}`);
      if (secrets.length) out.push(`${" ".repeat(15)}secrets (from the environment, never sent to Jev): ${secrets.join(", ")}`);
      for (const w of warnings(step, before, env)) { out.push(`${" ".repeat(15)}⚠ ${w}`); flagged++; }
      before.push(step);
    }
  }
  out.push("", flagged ? `${flagged} warning${flagged > 1 ? "s" : ""}.` : "No warnings.");
  return out.join("\n");
}
