// Benchmark for the replay-miss evidence (issue #135): on a page where the recorded target no longer matches, does
// telling Jev the old binding and why it missed (`recorded_target`) help it find the same control?
// Cases: the first Turn of every live action Step that ended DONE with a confident element target (>= 0.9), from the
// runs given. Each is asked on two changed pages, labelled with the control the run acted on:
//   relabel: the control's name changed ("Remove" -> "Remove item");
//   twin:    an identical control (same role and name) added at the top of the page.
// Each with and without the evidence. Reports accuracy, confidently wrong (passes the target gate, wrong control),
// latency p50/p90 and tokens per call, and how often runs ask it (replay misses and pre-dispatch re-checks per Step).
// Usage: node --env-file=.env scripts/bench-prior.ts --runs <runs dir>[,<runs dir>] [--max 60] [--concurrency 4]
import { readdirSync, readFileSync } from "node:fs";
import { describe, find, resolve } from "../src/cassette.ts";
import { DONE_THRESHOLD, gate, GATE_TARGET_MARGIN, GATE_TARGET_TOP, type Prior } from "../src/decision.ts";
import { ModelDecider, modelUsage } from "../src/model-decider.ts";
import { parseSnapshot } from "../src/observation.ts";
import { readStep } from "../src/step.ts";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const DIRS = arg("runs", "runs").split(",");
const MAX = Number(arg("max", "60"));
const CONCURRENCY = Number(arg("concurrency", "4"));
type Ev = any;

interface Case {
  step: string;
  ui: string;
  ref: string;
}
const cases: Case[] = [];
let steps = 0;
let heals = 0;
let rechecks = 0;
const live: { s: number; tokens: number }[] = [];
for (const dir of DIRS)
  for (const run of readdirSync(dir)) {
    let ev: Ev[];
    let log = "";
    try {
      ev = readFileSync(`${dir}/${run}/trace.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      log = readFileSync(`${dir}/${run}/log.txt`, "utf8");
    } catch {
      continue;
    }
    heals += log.match(/\(cassette: healing,/g)?.length ?? 0;
    rechecks += log.match(/Target changed before acting/g)?.length ?? 0;
    const outcome = new Map<string, string>();
    for (const e of ev)
      if (e.type === "step") {
        steps++;
        outcome.set(`${e.scenario}|${e.step}`, e.outcome);
        if (e.jevCalls > 0) live.push({ s: Number(e.seconds), tokens: e.inputTokens + e.outputTokens });
      }
    let ui = "";
    let last = "";
    for (const e of ev) {
      if (e.type === "observe") ui = e.ui;
      if (e.type !== "turn") continue;
      const k = `${e.scenario}|${e.step}`;
      const first = k !== last;
      last = k;
      const t = e.answer?.target;
      if (!first || !t || e.answer.done >= DONE_THRESHOLD || outcome.get(k) !== "DONE") continue;
      if ((t.probabilities[t.choice] ?? 0) < 0.9 || !/^f?\d*e\d+$/.test(t.choice)) continue;
      cases.push({ step: e.step, ui, ref: t.choice });
    }
  }

/** The page changed so that the recorded binding misses, the evidence Jev gets, and the control to find. */
function changed(c: Case, how: "relabel" | "twin") {
  const obs = parseSnapshot(c.ui);
  const el = obs.elements.find((e) => e.ref === c.ref);
  if (!el?.name) return;
  const binding = resolve(el, obs.elements, readStep({ text: c.step, kind: "action" }).quoted);
  const line = new RegExp(
    `^(\\s*- ${el.role} )"${el.name.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&")}"(.*\\[ref=${c.ref}\\])`,
    "m",
  );
  if (!line.test(c.ui)) return;
  const ui =
    how === "relabel"
      ? c.ui.replace(line, `$1"${el.name} item"$2`)
      : `- ${el.role} "${el.name.replace(/"/g, '\\"')}" [ref=twin1]\n${c.ui}`;
  const now = parseSnapshot(ui);
  const why = find(binding, now.elements);
  if (typeof why !== "string") return; // still found: no miss to resolve
  return { ui, prior: { binding: describe(binding), why } as Prior };
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? 0;
const rows: { how: string; evidence: boolean; right: boolean; wrongSure: boolean; ms: number; tokens: number }[] = [];
const jobs = cases.slice(0, MAX).flatMap((c) =>
  (["relabel", "twin"] as const).flatMap((how) => {
    const m = changed(c, how);
    return m ? [true, false].map((evidence) => ({ c, how, m, evidence })) : [];
  }),
);
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    const jev = new ModelDecider();
    while (next < jobs.length) {
      const { c, how, m, evidence } = jobs[next++];
      const before = modelUsage.inputTokens + modelUsage.outputTokens;
      const t0 = performance.now();
      try {
        const a = await jev.turn(c.step, parseSnapshot(m.ui), [], false, [], evidence ? m.prior : undefined);
        const right = a.target.choice === c.ref;
        const sure = gate(a.target, GATE_TARGET_TOP, GATE_TARGET_MARGIN);
        rows.push({
          how,
          evidence,
          right,
          wrongSure: !right && sure && a.target.choice !== "none",
          ms: performance.now() - t0,
          tokens: modelUsage.inputTokens + modelUsage.outputTokens - before, // shared counter: approximate under concurrency
        });
      } catch (err) {
        console.error(`${c.step}: ${(err as Error).message.split("\n")[0]}`);
      }
    }
  }),
);

console.log(`cases: ${cases.length} confident first Turns, ${jobs.length / 2} changed pages`);
for (const how of ["relabel", "twin"])
  for (const evidence of [true, false]) {
    const r = rows.filter((x) => x.how === how && x.evidence === evidence);
    if (!r.length) continue;
    const n = r.length;
    console.log(
      `${how.padEnd(8)} ${evidence ? "with evidence   " : "without evidence"} n=${n} right=${((100 * r.filter((x) => x.right).length) / n).toFixed(0)}% confidently-wrong=${((100 * r.filter((x) => x.wrongSure).length) / n).toFixed(0)}% p50=${pct(
        r.map((x) => x.ms),
        0.5,
      ).toFixed(0)}ms p90=${pct(
        r.map((x) => x.ms),
        0.9,
      ).toFixed(0)}ms tokens=${pct(
        r.map((x) => x.tokens),
        0.5,
      )}`,
    );
  }
console.log(
  `asked: ${heals} replay misses and ${rechecks} pre-dispatch re-checks in ${steps} Steps; median live Step ${pct(
    live.map((x) => x.s),
    0.5,
  ).toFixed(1)}s, ${pct(
    live.map((x) => x.tokens),
    0.5,
  )} tokens`,
);
