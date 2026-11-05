// Benchmark for issue #31: does Jev's reading of a Step's wording (jev.ts intent(), merged by step.ts withIntent())
// help, and at what cost? Two sets:
//   regression: every Step in the repo's .feature files, labelled by the wording rules' reading (must not get worse);
//   paraphrase: scripts/intent-cases.json, hand-labelled Steps written without the dialect (should get better).
// Per field: rules alone and shipped (rules + Jev's confident answers where they read nothing); then the
// added latency and tokens against the median live Step of earlier runs (runs/*/trace.jsonl).
// Usage: node --env-file=.env scripts/bench-intent.ts [--only paraphrase|regression] [--concurrency 4]
// Answers are cached in runs/bench-intent/cache.json (delete it to re-measure latency).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Intent } from "../src/decision.ts";
import { parseFeature } from "../src/feature.ts";
import { JevDecider, jevUsage, MODEL } from "../src/jev.ts";
import { readStep, stepKind, withIntent, type StepReading } from "../src/step.ts";

type Kind = "action" | "assertion";
interface Labels {
  attempt?: boolean;
  toggle?: "on" | "off" | "na";
  nav?: string;
  key?: string;
  pressOnly?: boolean;
  values?: string[];
  exact?: boolean;
  clear?: boolean;
}
interface Case extends Labels {
  text: string;
  kind: Kind;
  lang?: string;
  set: "regression" | "paraphrase";
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ONLY = arg("only");
const CONCURRENCY = Number(arg("concurrency") ?? 4);
const OUT = "runs/bench-intent";
const CACHE = join(OUT, "cache.json");
const FIELDS = ["attempt", "toggle", "nav", "key", "pressOnly", "clear", "values", "exact"] as const;

/** A reading in the labels' terms. `attempt`: the Step's prefix (rules) or Jev's. */
function labelsOf(r: StepReading & { attempt?: boolean }, text: string, kind: Kind): Labels {
  if (kind === "assertion") return { values: r.values, exact: r.exact };
  return {
    attempt: stepKind({ text }) === "attempt" || !!r.attempt,
    toggle: r.toggle === undefined ? "na" : r.toggle ? "on" : "off",
    nav: r.navigation ? r.navigation.verb.toLowerCase() : "none",
    key: r.pressOnly ?? r.keys[0] ?? "none",
    pressOnly: !!r.pressOnly,
    clear: r.candidates.includes(""),
    values: [...r.candidates.filter((c) => c !== ""), ...(r.navigation?.value ? [r.navigation.value] : [])],
  };
}
const rules = (text: string, kind: Kind) => readStep({ text, kind: kind === "assertion" ? kind : stepKind({ text }) });

type Score = "ok" | "wrong";
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
function score(f: (typeof FIELDS)[number], label: unknown, got: unknown): Score {
  if (f !== "values") return String(label).toLowerCase() === String(got).toLowerCase() ? "ok" : "wrong";
  const want = label as string[],
    have = (got as string[]).map(norm);
  if (!want.length) return have.length ? "wrong" : "ok";
  return want.some((l) => have.includes(norm(l))) ? "ok" : "wrong";
}

function regressionCases(): Case[] {
  const seen = new Set<string>();
  const out: Case[] = [];
  for (const f of execSync("git ls-files '*.feature'", { encoding: "utf8" }).trim().split("\n")) {
    let scenarios: ReturnType<typeof parseFeature>;
    try {
      scenarios = parseFeature(readFileSync(f, "utf8"), f);
    } catch {
      continue;
    }
    for (const st of scenarios.flatMap((s) => s.steps)) {
      if (st.table || st.docString) continue; // rows and doc strings keep their own reading
      const kind: Kind = st.kind === "assertion" ? "assertion" : "action";
      if (seen.has(`${kind}|${st.text}`)) continue;
      seen.add(`${kind}|${st.text}`);
      const labels = labelsOf(rules(st.text, kind), st.text, kind);
      delete labels.toggle; // "on" is the rules' default for every Step, not a reading: toggles only on paraphrases
      out.push({ text: st.text, kind, set: "regression", ...labels });
    }
  }
  return out;
}
const paraphraseCases = (): Case[] =>
  JSON.parse(readFileSync("scripts/intent-cases.json", "utf8")).map((c: Case) => ({ ...c, set: "paraphrase" }));

function pct(xs: number[], p: number) {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
/** Median live Step and seconds per Jev call, from earlier runs. */
function baseline() {
  const secs: number[] = [];
  for (const d of existsSync("runs") ? readdirSync("runs") : []) {
    const p = join("runs", d, "trace.jsonl");
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.includes('"step"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "step" && e.jevCalls > 0 && e.seconds) secs.push(e.seconds);
      } catch {}
    }
  }
  return { steps: secs.length, stepS: pct(secs, 50) };
}

type Cached = { intent: Intent; ms: number; inputTokens: number; outputTokens: number };
const cache: Record<string, Cached> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
const cases = [
  ...(ONLY === "paraphrase" ? [] : regressionCases()),
  ...(ONLY === "regression" ? [] : paraphraseCases()),
];
const jev = new JevDecider();
const results: (Case & Cached)[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < cases.length) {
      const c = cases[next++];
      const key = `${MODEL}|${c.kind}|${c.text}`;
      if (!cache[key]) {
        const before = { ...jevUsage },
          t0 = performance.now();
        try {
          const intent = await jev.intent(c.text, c.kind === "assertion");
          // Concurrent calls share jevUsage: tokens are approximate under concurrency > 1.
          cache[key] = {
            intent,
            ms: performance.now() - t0,
            inputTokens: jevUsage.inputTokens - before.inputTokens,
            outputTokens: jevUsage.outputTokens - before.outputTokens,
          };
        } catch (err) {
          console.error(`skip "${c.text}": ${(err as Error).message}`);
          continue;
        }
      }
      results.push({ ...c, ...cache[key] });
    }
  }),
);
mkdirSync(OUT, { recursive: true });
writeFileSync(CACHE, JSON.stringify(cache, null, 1));

const lines = [`# Intent benchmark (${MODEL}, ${new Date().toISOString()})`, ""];
for (const set of ["regression", "paraphrase"] as const) {
  const rs = results.filter((r) => r.set === set);
  if (!rs.length) continue;
  lines.push(
    `## ${set} (${rs.length} Steps)`,
    "",
    "| field | n | rules ok | shipped ok | shipped wrong |",
    "|---|---|---|---|---|",
  );
  const misses: string[] = [];
  for (const f of FIELDS) {
    // An action's value is asked only once a field is chosen (runtime value()), so "no value" there is never asked.
    const scored = rs.filter(
      (r) => r[f] !== undefined && !(f === "values" && r.kind === "action" && !r.values?.length),
    );
    if (!scored.length) continue;
    const t = { rules: 0, shipped: 0, shippedWrong: 0 };
    for (const r of scored) {
      const base = rules(r.text, r.kind);
      if (score(f, r[f], labelsOf(base, r.text, r.kind)[f]) === "ok") t.rules++;
      const got = labelsOf(withIntent(base, r.intent), r.text, r.kind)[f];
      if (score(f, r[f], got) === "ok") t.shipped++;
      else {
        t.shippedWrong++;
        misses.push(`- ${f}: "${r.text}" expected ${JSON.stringify(r[f])}, shipped ${JSON.stringify(got)}`);
      }
    }
    const pc = (n: number) => `${n} (${Math.round((100 * n) / scored.length)}%)`;
    lines.push(`| ${f} | ${scored.length} | ${pc(t.rules)} | ${pc(t.shipped)} | ${pc(t.shippedWrong)} |`);
  }
  lines.push("", `Shipped misses (${misses.length}):`, "", ...misses, "");
}
const fresh = results.filter((r) => r.ms > 0);
const b = baseline();
const p50 = pct(
  fresh.map((r) => r.ms),
  50,
);
lines.push(
  "## Cost",
  "",
  `- Intent request: p50 ${(p50 / 1000).toFixed(2)} s, p95 ${(
    pct(
      fresh.map((r) => r.ms),
      95,
    ) / 1000
  ).toFixed(2)} s; tokens/Step in ~${Math.round(
    pct(
      fresh.map((r) => r.inputTokens),
      50,
    ),
  )}, out ~${Math.round(
    pct(
      fresh.map((r) => r.outputTokens),
      50,
    ),
  )} (n=${fresh.length})`,
  `- Live Step today (${b.steps} Steps from runs/): median ${b.stepS.toFixed(2)} s; intent adds +${((100 * p50) / 1000 / b.stepS).toFixed(0)}% at p50`,
  "- Replay (`--record none`): +0, the intent is stored in the cassette",
);
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
writeFileSync(join(OUT, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
