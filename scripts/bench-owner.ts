// Benchmark for the owner question (B): after an Action step has acted, which line of the Scenario asks for the
// element Jev chose next? Another line = this Step is over (the rest is a later Step's work).
// Cases: every recorded live Turn in runs/ that follows an action in the same Step and picks an element, latest run per
// feature. Expected "this line"; every case attributed elsewhere is printed for review (it is either a false stop or an
// overshoot the old run made).
// Usage: node --env-file=.env scripts/bench-owner.ts [--at examples/] [--until <run id>] [--concurrency 4]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { DONE_THRESHOLD, describeAction } from "../src/decision.ts";
import { choice } from "../src/decision-provider.ts";
import { parseSnapshot } from "../src/observation.ts";
import { reduceUi } from "../src/model-decider.ts";
import { createProvider } from "../src/providers.ts";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const AT = arg("at", "examples/");
const CONCURRENCY = Number(arg("concurrency", "4"));
const UNTIL = arg("until", "9"); // runs/ ids up to this one: runs made with the question stop where it said so
type Ev = any;

// Latest run per feature file under AT.
const latest = new Map<string, string>();
for (const r of readdirSync("runs").sort()) {
  if (r > UNTIL) continue;
  let t: string;
  try {
    t = readFileSync(`runs/${r}/trace.jsonl`, "utf8");
    statSync(`runs/${r}/log.txt`);
  } catch {
    continue;
  }
  for (const m of t.matchAll(/"at":"([^"]+?):\d+"/g)) if (m[1].startsWith(AT)) latest.set(m[1], r);
}
const runs = [...new Set(latest.values())];

interface Case {
  run: string;
  scenario: string[]; // current line marked ">> "
  step: string;
  turn: number;
  recent: string[];
  ui: string;
  next: string;
  how: string;
  outcome: string;
}
// A data-table row's Turns carry the row's own text and no Step event: its line is the table Step it starts like.
const rowOf = (lines: Map<number, string>, step: string) =>
  [...lines].find(([, s]) => s.includes(": [") && step.startsWith(s.slice(0, s.indexOf(": ["))))?.[0];
const cases: Case[] = [];
for (const run of runs) {
  const ev: Ev[] = readFileSync(`runs/${run}/trace.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const log = readFileSync(`runs/${run}/log.txt`, "utf8").split("\n");
  const executed: string[] = [];
  for (let i = 0; i < log.length; i++) {
    const m = log[i].match(/^\s+Execute: (.*)$/);
    if (m) executed.push(log[i + 1]?.match(/^\s+Effect: /) ? `${m[1]} -> ${log[i + 1].trim().slice(8)}` : m[1]);
  }
  // Scenario lines per scenario name, from the Steps' `at` lines (Background included, it shares the file).
  const byScenario = new Map<string, Map<number, string>>();
  const outcome = new Map<string, string>();
  const lineOf = new Map<string, number>(); // a data-table row runs as its own Step text: mark by line, not text
  for (const e of ev)
    if (e.type === "step" && e.at?.startsWith(AT) && e.kind !== "assertion") {
      // only Action steps, as steps.ts offers them
      if (!byScenario.has(e.scenario)) byScenario.set(e.scenario, new Map());
      byScenario.get(e.scenario)!.set(Number(e.at.split(":").pop()), e.step);
      outcome.set(`${e.scenario}|${e.step}`, e.outcome);
      lineOf.set(`${e.scenario}|${e.step}`, Number(e.at.split(":").pop()));
    }
  let exec = 0;
  let key = "";
  let recent: string[] = [];
  let turn = 0;
  let ui = "";
  for (const e of ev) {
    if (e.type === "observe") ui = e.ui;
    if (e.type !== "turn" || !e.answer?.target?.probabilities) continue;
    const k = `${e.scenario}|${e.step}`;
    if (k !== key) [key, recent, turn] = [k, [], 0];
    const a = e.answer;
    const acts = a.done < DONE_THRESHOLD && a.target.choice !== "none";
    const lines = byScenario.get(e.scenario);
    if (acts && recent.length && lines && a.target.choice !== "page") {
      const next = parseSnapshot(ui)
        .elements.find((x) => x.ref === a.target.choice)
        ?.line.trim();
      if (next)
        cases.push({
          run,
          scenario: [...lines.entries()]
            .sort((x, y) => x[0] - y[0])
            .map(([n, s]) => (n === (lineOf.get(k) ?? rowOf(lines, e.step)) ? `>> ${s}` : s)),
          step: e.step,
          turn,
          recent: [...recent],
          ui,
          next,
          how: a.action?.choice ?? "click",
          outcome: outcome.get(k) ?? "?",
        });
    }
    if (acts && exec < executed.length) recent.push(executed[exec++]);
    turn++;
  }
}

const provider = createProvider();
const rows: { c: Case; p: number; got: string; ms: number; tokens: number }[] = [];
let i = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (i < cases.length) {
      const c = cases[i++];
      const lines = Object.fromEntries(c.scenario.map((s, n) => [`line ${n + 1}`, s.replace(/^>> /, "")]));
      const current = `line ${c.scenario.findIndex((s) => s.startsWith(">> ")) + 1}`;
      const t0 = performance.now();
      // Over budget, the runner sends the sections that matter for the Step; same question as ModelDecider.#ui.
      const ui = await reduceUi(c.ui, async (sections) => {
        const r = await provider.decide(
          {
            state: { step: c.step, ...sections },
            questions: {
              pick: choice(
                "Which of these sections of the page holds what `step` needs?",
                Object.fromEntries(Object.keys(sections).map((k) => [k, `section \`${k}\``])),
              ),
            },
          },
          { timeoutMs: 30000 },
        );
        return r.answers.pick;
      });
      const res = await provider.decide(
        {
          state: {
            scenario: c.scenario,
            step: c.step,
            actions_taken_for_step: c.recent,
            ui,
            next_element: c.next,
            next_action: describeAction(c.how),
          },
          questions: {
            owner: choice(
              "`step` is the line of `scenario` marked `>>`; it has performed `actions_taken_for_step`. Which line of `scenario` asks for doing `next_action` on `next_element` now?",
              lines,
            ),
          },
        },
        { timeoutMs: 30000 },
      );
      const o = res.answers.owner;
      rows.push({
        c,
        p: o.probabilities[current] ?? 0,
        got: o.choice === current ? "this" : `${o.choice}: ${lines[o.choice]}`,
        ms: performance.now() - t0,
        tokens: (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0),
      });
    }
  }),
);

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];
const stops = rows.filter((r) => r.p < 0.5);
console.log(`runs ${runs.length}, cases ${rows.length}; P(this line) < 0.5 (would end the Step): ${stops.length}`);
console.log(
  `P(this line) among the rest: min ${pct(
    rows.filter((r) => r.p >= 0.5).map((r) => r.p),
    0,
  )?.toFixed(2)}, p10 ${pct(
    rows.filter((r) => r.p >= 0.5).map((r) => r.p),
    0.1,
  )?.toFixed(2)}`,
);
console.log(
  `latency p50 ${pct(
    rows.map((r) => r.ms),
    0.5,
  ).toFixed(0)} ms p90 ${pct(
    rows.map((r) => r.ms),
    0.9,
  ).toFixed(0)} ms; tokens/call p50 ${pct(
    rows.map((r) => r.tokens),
    0.5,
  )}`,
);
console.log(
  `Steps with a case: ${new Set(rows.map((r) => r.c.run + r.c.step)).size}; recorded Turns in these runs: ${runs.reduce((n, r) => n + (readFileSync(`runs/${r}/trace.jsonl`, "utf8").match(/"type":"turn"/g)?.length ?? 0), 0)}`,
);
for (const r of rows.sort((a, b) => a.p - b.p).slice(0, Math.max(stops.length + 8, 15)))
  console.log(
    `${r.p < 0.5 ? "STOP" : "keep"} P=${r.p.toFixed(2)} [${r.c.outcome}] ${r.c.step} #${r.c.turn} -> ${r.c.next.slice(0, 60)}\n      got ${r.got.slice(0, 90)}\n      recent: ${r.c.recent.map((s) => s.slice(0, 50)).join(" ; ")}`,
  );
