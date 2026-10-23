// `descisium explain <file.feature> [--diff <git-ref>]`: what each Step resolved to, read from its cassette with no
// browser and no Jev (task 0035). For PR review: `--diff` keeps only the Steps whose resolution changed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, readEntries, stepKey, type Answer, type Entry } from "./cassette.ts";
import { parseFeature } from "./feature.ts";
import { quoted } from "./observation.ts";
import { KIND } from "./report.ts";

const SPECIAL: Record<string, string> = {
  none: "nothing", page: "anywhere on the page", missing: "an area not on the screen",
  scroll: "scroll down", wait: "wait for loading", enter: "press Enter",
};
const top = (a?: Answer) => a?.[0] ? (typeof a[0][0] === "string" ? SPECIAL[a[0][0]] ?? a[0][0] : describe(a[0][0])) : "-";
const topKey = (p: { probabilities: Record<string, number> }) => Object.entries(p.probabilities).sort((x, y) => y[1] - x[1])[0]?.[0];

/** One Step's resolution, for people. */
export function resolution(text: string, e: Entry | undefined): string[] {
  if (!e) return ["not resolved yet: the next run asks Jev"];
  const out: string[] = [];
  if (e.recall) out.push(`refers to the earlier value "${top(e.recall)}"`);
  e.turns?.forEach((t, i) => {
    const last = i === e.turns!.length - 1;
    if (last && t.done >= 0.5) out.push("done");
    else out.push(`${i + 1}. ${top(t.target)}${t.value ? ` <- "${top(t.value)}"` : ""}`);
  });
  if (e.check) {
    const kind = topKey(e.check.kind);
    const values = quoted(text).map(v => `"${v}"`).join(", ") || (e.recall ? `"${top(e.recall)}"` : "nothing quoted");
    out.push(kind === "presence" || kind === "absence" ? `${kind}: ${values} in ${top(e.check.area)}`
      : kind === "state" ? `state: ${top(e.check.subject)} is ${topKey(e.check.state)}`
      : kind === "fuzzy" ? "fuzzy: judged by Jev (--judged), not recorded"
      : `value: ${values} in ${top(e.check.subject)}`);
  }
  return out;
}

/** Per Step of the feature, in file order: its header and resolution lines. */
function steps(path: string, entries: Record<string, Entry>) {
  return parseFeature(readFileSync(path, "utf8"), path).flatMap(s => s.steps.map((step, i) => ({
    scenario: s.name,
    head: `  ${String(step.line ?? "").padStart(4)}  ${KIND[step.kind].padEnd(7)} ${step.text}`,
    lines: resolution(step.text, entries[stepKey(s.name, i, step.text)]),
  })));
}

const cassettePath = (feature: string) => feature.replace(/\.feature$/, "") + ".cassette.json";

/** The explanation of one feature, or with `diff` only the Steps whose resolution differs from the cassette at that git ref. */
export function explain(path: string, diff?: string): string {
  const file = cassettePath(path);
  const now = steps(path, readEntries(existsSync(file) ? readFileSync(file, "utf8") : undefined));
  const out = [`${path}  (${existsSync(file) ? file : "no cassette yet"})`];
  if (diff === undefined) {
    let scenario = "";
    for (const s of now) {
      if (s.scenario !== scenario) out.push("", `  Scenario: ${(scenario = s.scenario)}`);
      out.push(s.head, ...s.lines.map(l => `${" ".repeat(15)}${l}`));
    }
    return out.join("\n");
  }
  let old: string | undefined;
  try { old = execFileSync("git", ["show", `${diff}:./${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { old = undefined; }
  const before = steps(path, readEntries(old));
  const changed = now.filter((s, i) => s.lines.join("\n") !== before[i]?.lines.join("\n"));
  for (const s of changed) {
    const b = before[now.indexOf(s)];
    out.push("", `  Scenario: ${s.scenario}`, s.head,
      ...(b?.lines ?? []).map(l => `${" ".repeat(13)}- ${l}`), ...s.lines.map(l => `${" ".repeat(13)}+ ${l}`));
  }
  out.push("", changed.length ? `${changed.length} step${changed.length > 1 ? "s" : ""} resolved differently than at ${diff}.` : `No step resolved differently than at ${diff}.`);
  return out.join("\n");
}
