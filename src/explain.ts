// `descisium explain <file.feature>`: what each Step will be taken as, read without a browser or Jev (task 0031).
// Per Step: its kind, the quoted values Jev can pick from, secret placeholders, and warnings for wordings that
// docs/cookbook.md shows failing.
import { readFileSync } from "node:fs";
import { parseFeature, type ParsedStep } from "./feature.ts";
import { KIND } from "./report.ts";
import { placeholder, quoted, stepValues } from "./observation.ts";

const SEE = "see docs/cookbook.md";

/** Cookbook warnings for one Step. `before`: the scenario's earlier Steps. */
export function warnings(step: ParsedStep, before: ParsedStep[], env: Record<string, string | undefined> = process.env): string[] {
  const t = step.text;
  const earlier = before.flatMap(s => quoted(s.text)).filter(v => !placeholder(v));
  const values = quoted(t);
  const out: string[] = [];
  for (const name of values.map(placeholder).filter(n => n !== undefined)) {
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
    if (/^(I\s+)?(check|tick)\b/i.test(t)) out.push("checking a box is unreliable: Jev keeps clicking it (docs/tasks/0033-toggle-steps-oscillate.md)");
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
export function explain(path: string, env: Record<string, string | undefined> = process.env): string {
  const out = [path];
  let flagged = 0;
  for (const s of parseFeature(readFileSync(path, "utf8"), path)) {
    out.push("", `  Scenario: ${s.name}${s.url ? `  (${s.url})` : ""}`);
    const before: ParsedStep[] = [];
    for (const step of s.steps) {
      const values = step.kind === "assertion" ? quoted(step.text) : stepValues(step.text);
      const secrets = values.filter(v => placeholder(v));
      out.push(`  ${String(step.line ?? "").padStart(4)}  ${KIND[step.kind].padEnd(7)} ${step.text}`);
      const shown = values.filter(v => !placeholder(v));
      if (shown.length) out.push(`${" ".repeat(15)}${step.kind === "assertion" ? "compares" : "values"}: ${shown.map(v => `"${v}"`).join(", ")}`);
      if (secrets.length) out.push(`${" ".repeat(15)}secrets (from the environment, never sent to Jev): ${secrets.join(", ")}`);
      for (const w of warnings(step, before, env)) { out.push(`${" ".repeat(15)}⚠ ${w}`); flagged++; }
      before.push(step);
    }
  }
  out.push("", flagged ? `${flagged} warning${flagged > 1 ? "s" : ""}.` : "No warnings.");
  return out.join("\n");
}
