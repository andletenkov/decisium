// Benchmark for issue #27: can one Jev "intent" request per Step replace the wording regexes in src/step.ts, and at
// what cost? Two sets:
//   regression: every Step in the repo's .feature files, labelled by today's regex reading (must not get worse);
//   paraphrase: scripts/intent-cases.json, hand-labelled Steps written without the dialect (should get better).
// Per field it reports regex accuracy, Jev accuracy and Jev AMBIGUOUS rate (gated like runtime answers), plus the
// added latency and tokens against the median live Step from earlier runs (runs/*/trace.jsonl).
// Usage: node --env-file=.env scripts/bench-intent.ts [--only paraphrase|regression] [--concurrency 4]
// Answers are cached in runs/bench-intent/cache.json (delete it to re-measure latency).
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { parseFeature } from "../src/feature.ts";
import { MODEL } from "../src/jev.ts";
import { readStep, stepKind } from "../src/step.ts";

type Kind = "action" | "assertion";
interface Labels {
  attempt?: boolean;
  toggle?: "on" | "off" | "na";
  nav?: string;
  key?: string;
  pressOnly?: boolean;
  values?: string[];
  exact?: boolean;
}
interface Case extends Labels {
  text: string;
  kind: Kind;
  lang?: string;
  set: "regression" | "paraphrase";
}
type Reading = { [K in keyof Labels]: Labels[K] | "AMBIGUOUS" } & { value?: string | "AMBIGUOUS" };

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ONLY = arg("only");
const CONCURRENCY = Number(arg("concurrency") ?? 4);
const OUT = "runs/bench-intent";
const CACHE = join(OUT, "cache.json");

// ---------- regex reading (today) ----------
function regexReading(text: string, kind: Kind): Labels {
  const r = readStep({ text, kind: kind === "assertion" ? "assertion" : stepKind({ text }) });
  if (kind === "assertion") return { values: r.values, exact: r.exact };
  return {
    attempt: stepKind({ text }) === "attempt",
    toggle: r.toggle === undefined ? "na" : r.toggle ? "on" : "off",
    nav: r.navigation ? r.navigation.verb.toLowerCase() : "none",
    key: r.pressOnly ?? r.keys[0] ?? "none",
    pressOnly: !!r.pressOnly,
    values: [...r.candidates.filter((c) => c !== ""), ...(r.navigation?.value ? [r.navigation.value] : [])],
  };
}

// ---------- Jev reading (proposal) ----------
const KEYS = [
  ..."Escape Tab Enter Backspace Delete Home End PageUp PageDown ArrowUp ArrowDown ArrowLeft ArrowRight Space".split(
    " ",
  ),
  ..."Control+A Control+C Control+V Control+K Control+Z Meta+K Shift+Tab".split(" "),
];
const NAV = {
  none: "None of these: `step` is not only a browser navigation.",
  back: "Go back in the browser history.",
  forward: "Go forward in the browser history.",
  reload: "Reload the page.",
  goto: "Go to a URL or path that `step` gives.",
  close_tab: "Close the current browser tab.",
  switch_tab: "Switch to the previous browser tab.",
};

/** Contiguous word spans of `text` (quotes stripped), up to 8 words: the value candidates. */
export function spans(text: string): string[] {
  const words = text
    .replace(/["“”]/g, "")
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?;:]+$/, ""))
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++)
    for (let n = 1; n <= 8 && i + n <= words.length; n++) out.add(words.slice(i, i + n).join(" "));
  return [...out];
}

type Pick = { choice: string; probabilities: Record<string, number> };
const gated = (p: Pick) => {
  const [a = 0, b = 0] = Object.values(p.probabilities).sort((x, y) => y - x);
  return a >= 0.8 && a - b >= 0.3 ? p.choice : "AMBIGUOUS";
};
// Yes/no as a two-option choice: noul answers stayed 0.6-0.7 on clear yeses (probe: "exactly these items" 0.68).
const YN = { yes: "Yes.", no: "No." };
const yn = (q: string) => choice(q, YN);
const yesNo = (p: Pick) => {
  const g = gated(p);
  return g === "AMBIGUOUS" ? g : g === "yes";
};

function request(text: string, kind: Kind) {
  const sp = spans(text);
  const valueCriteria = {
    none: "None: `step` only names actions, controls, pages or fields.",
    ...Object.fromEntries(sp.map((s, i) => [`s${i}`, `"${s}"`])),
  };
  const valueQ =
    kind === "assertion"
      ? "Which part of `step` is the exact text or value the page is expected to show?"
      : "Which words of `step` are free text the user types, selects or visits, as opposed to names of buttons, links, pages or fields?";
  const questions =
    kind === "assertion"
      ? {
          value: choice(valueQ, valueCriteria),
          exact: yn("Does `step` say a list must match exactly, with nothing else, or in a given order?"),
        }
      : {
          value: choice(valueQ, valueCriteria),
          attempt: yn(
            "Does `step` try something the app may refuse (a negative path), so it is done once performed, whether or not the app accepts it?",
          ),
          toggle: choice("If `step` sets a checkbox or switch, how should it end?", {
            on: "Turned on / checked.",
            off: "Turned off / unchecked.",
            na: "`step` sets no checkbox or switch.",
          }),
          nav: choice("Is `step` only one of these browser navigations?", NAV),
          // Two questions: one choice over "none" + 21 keys spread "none" thin (probe: "I go back" none < 0.3).
          presses: yn("Does `step` press a keyboard key (not click a button)?"),
          key: choice(
            "Which keyboard key does `step` press?",
            Object.fromEntries(KEYS.map((k, i) => [`k${i}`, `The ${k} key.`])),
          ),
          pressOnly: yn("Is pressing keyboard keys all that `step` asks for?"),
        };
  return { sp, body: { state: { step: text }, questions } };
}

async function jevReading(client: TypeSafeClient, text: string, kind: Kind) {
  const { sp, body } = request(text, kind);
  const t0 = performance.now();
  const res = await client.systemOne(body as unknown as Parameters<TypeSafeClient["systemOne"]>[0]);
  const ms = performance.now() - t0;
  const a = res.answers as Record<string, any>;
  const v = gated(a.value);
  const reading: Reading = { value: v === "none" || v === "AMBIGUOUS" ? v : sp[Number(v.slice(1))] };
  if (kind === "assertion") reading.exact = yesNo(a.exact);
  else {
    reading.attempt = yesNo(a.attempt);
    reading.toggle = gated(a.toggle) as Reading["toggle"];
    reading.nav = gated(a.nav);
    const presses = yesNo(a.presses);
    const k = gated(a.key);
    reading.key =
      presses === "AMBIGUOUS" ? presses : !presses ? "none" : k === "AMBIGUOUS" ? k : KEYS[Number(k.slice(1))];
    reading.pressOnly = yesNo(a.pressOnly);
  }
  return { reading, ms, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
}

// ---------- scoring ----------
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
type Score = "ok" | "wrong" | "ambiguous";
/** Regex reads a set of values; Jev picks one. Both are right if they hit a labelled value (or none when there is none). */
function scoreValue(label: string[], got: string[] | string): Score {
  if (got === "AMBIGUOUS") return "ambiguous";
  const set = (Array.isArray(got) ? got : got === "none" ? [] : [got]).map(norm);
  if (!label.length) return set.length ? "wrong" : "ok";
  return label.some((l) => set.includes(norm(l))) ? "ok" : "wrong";
}
const scoreField = (label: unknown, got: unknown): Score =>
  got === "AMBIGUOUS" ? "ambiguous" : String(label).toLowerCase() === String(got).toLowerCase() ? "ok" : "wrong";
/**
 * Hybrid: keep what the regex reads, and take Jev's confident answer only where the regex read its default (no attempt,
 * no key, no navigation, no quote...). Jev can then only add readings the dialect missed; AMBIGUOUS falls back to regex.
 */
function hybrid(rx: Labels, jv: Reading, kind: Kind): Reading {
  const take = <T>(r: T, isDefault: boolean, j: unknown) => (isDefault && j !== undefined && j !== "AMBIGUOUS" ? j : r);
  const out: Reading = {
    values: rx.values,
    value: rx.values?.length ? undefined : jv.value === "AMBIGUOUS" ? undefined : jv.value,
  };
  if (kind === "assertion") out.exact = take(rx.exact, rx.exact === false, jv.exact) as boolean;
  else {
    out.attempt = take(rx.attempt, rx.attempt === false, jv.attempt) as boolean;
    out.toggle = take(rx.toggle, rx.toggle !== "off", jv.toggle) as Labels["toggle"];
    out.nav = take(rx.nav, rx.nav === "none", jv.nav) as string;
    out.key = take(rx.key, rx.key === "none", jv.key) as string;
    out.pressOnly = take(rx.pressOnly, rx.pressOnly === false, jv.pressOnly) as boolean;
  }
  return out;
}
const hybridValues = (h: Reading) => (h.values?.length ? h.values : h.value && h.value !== "none" ? [h.value] : []);

const FIELDS = ["attempt", "toggle", "nav", "key", "pressOnly", "values", "exact"] as const;

// ---------- cases ----------
function regressionCases(): Case[] {
  const files = execSync("git ls-files '*.feature'", { encoding: "utf8" }).trim().split("\n");
  const seen = new Set<string>();
  const out: Case[] = [];
  for (const f of files) {
    let scenarios: ReturnType<typeof parseFeature>;
    try {
      scenarios = parseFeature(readFileSync(f, "utf8"), f);
    } catch {
      continue;
    }
    for (const s of scenarios)
      for (const st of s.steps) {
        if (st.table || st.docString) continue; // rows and doc strings keep their own reading
        const kind: Kind = st.kind === "assertion" ? "assertion" : "action";
        if (seen.has(`${kind}|${st.text}`)) continue;
        seen.add(`${kind}|${st.text}`);
        const labels = regexReading(st.text, kind);
        // toggle "on" is the regex default for every Step, not a reading: score toggles only on the paraphrase set.
        delete labels.toggle;
        out.push({ text: st.text, kind, set: "regression", ...labels });
      }
  }
  return out;
}
const paraphraseCases = (): Case[] =>
  JSON.parse(readFileSync("scripts/intent-cases.json", "utf8")).map((c: Case) => ({ ...c, set: "paraphrase" }));

// ---------- baseline: a live Step today ----------
function baseline() {
  const secs: number[] = [];
  const perCall: number[] = [];
  if (existsSync("runs"))
    for (const d of readdirSync("runs")) {
      const p = join("runs", d, "trace.jsonl");
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.includes('"step"')) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === "step" && e.jevCalls > 0 && e.seconds) {
            secs.push(e.seconds);
            perCall.push(e.seconds / e.jevCalls);
          }
        } catch {}
      }
    }
  return { steps: secs.length, stepS: pct(secs, 50), callS: pct(perCall, 50) };
}
function pct(xs: number[], p: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// ---------- main ----------
async function main() {
  mkdirSync(OUT, { recursive: true });
  const cache: Record<string, Awaited<ReturnType<typeof jevReading>>> = existsSync(CACHE)
    ? JSON.parse(readFileSync(CACHE, "utf8"))
    : {};
  const cases = [
    ...(ONLY === "paraphrase" ? [] : regressionCases()),
    ...(ONLY === "regression" ? [] : paraphraseCases()),
  ];
  const client = new TypeSafeClient({ defaultModel: MODEL });
  const results: (Case & { regex: Labels; jev: Reading; ms: number; inputTokens: number; outputTokens: number })[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < cases.length) {
        const c = cases[next++];
        const key = `${MODEL}|${c.kind}|${c.text}`;
        try {
          cache[key] ??= await jevReading(client, c.text, c.kind);
        } catch (err) {
          console.error(`skip "${c.text}": ${(err as Error).message}`);
          continue;
        }
        results.push({ ...c, regex: regexReading(c.text, c.kind), ...cache[key], jev: cache[key].reading });
      }
    }),
  );
  writeFileSync(CACHE, JSON.stringify(cache, null, 1));

  const lines: string[] = [`# Intent benchmark (${MODEL}, ${new Date().toISOString()})`, ""];
  for (const set of ["regression", "paraphrase"] as const) {
    const rs = results.filter((r) => r.set === set);
    if (!rs.length) continue;
    lines.push(
      `## ${set} (${rs.length} Steps)`,
      "",
      "| field | n | regex ok | Jev ok | Jev wrong | Jev AMBIGUOUS | hybrid ok | hybrid wrong |",
      "|---|---|---|---|---|---|---|---|",
    );
    const misses: string[] = [];
    for (const f of FIELDS) {
      // An action's value is asked only once a field is chosen (runtime value()), so "none" there is never asked.
      const scored = rs.filter(
        (r) => r[f] !== undefined && !(f === "values" && r.kind === "action" && !r.values!.length),
      );
      if (!scored.length) continue;
      const tally = { regex: 0, ok: 0, wrong: 0, ambiguous: 0, hybrid: 0, hybridWrong: 0 };
      for (const r of scored) {
        const rx = f === "values" ? scoreValue(r.values!, r.regex.values ?? []) : scoreField(r[f], r.regex[f]);
        const jv = f === "values" ? scoreValue(r.values!, r.jev.value ?? "none") : scoreField(r[f], r.jev[f]);
        const h = hybrid(r.regex, r.jev, r.kind);
        const hy = f === "values" ? scoreValue(r.values!, hybridValues(h)) : scoreField(r[f], h[f]);
        if (hy === "ok") tally.hybrid++;
        else tally.hybridWrong++;
        if (rx === "ok") tally.regex++;
        tally[jv]++;
        if (jv !== "ok")
          misses.push(
            `- ${f}: "${r.text}" expected ${JSON.stringify(r[f])}, Jev ${JSON.stringify(f === "values" ? r.jev.value : r.jev[f])}, regex ${rx}`,
          );
      }
      const pc = (n: number) => `${n} (${Math.round((100 * n) / scored.length)}%)`;
      lines.push(
        `| ${f} | ${scored.length} | ${pc(tally.regex)} | ${pc(tally.ok)} | ${pc(tally.wrong)} | ${pc(tally.ambiguous)} | ${pc(tally.hybrid)} | ${pc(tally.hybridWrong)} |`,
      );
    }
    lines.push("", `<details><summary>Jev misses (${misses.length})</summary>`, "", ...misses, "", "</details>", "");
  }

  const fresh = results.filter((r) => r.ms > 0);
  const ms = fresh.map((r) => r.ms);
  const b = baseline();
  const p50 = pct(ms, 50) / 1000,
    p95 = pct(ms, 95) / 1000;
  lines.push(
    "## Cost",
    "",
    `- Intent request: p50 ${p50.toFixed(2)} s, p95 ${p95.toFixed(2)} s; tokens/Step in ${Math.round(
      pct(
        fresh.map((r) => r.inputTokens),
        50,
      ),
    )}, out ${Math.round(
      pct(
        fresh.map((r) => r.outputTokens),
        50,
      ),
    )} (n=${fresh.length}, concurrency ${CONCURRENCY})`,
    `- Live Step today (${b.steps} Steps from runs/): median ${b.stepS.toFixed(2)} s, median ${b.callS.toFixed(2)} s per Jev call`,
    `- Added to a live Step: +${((100 * p50) / b.stepS).toFixed(0)}% at p50 (sequential; 0 if sent in parallel with Turn 1, which needs only the keys answer)`,
    "- Replay (`--record none`): +0, the reading is stored in the cassette",
  );
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
  const report = lines.join("\n");
  writeFileSync(join(OUT, "report.md"), report + "\n");
  console.log(report);
}

await main();
