// Runs every feature in examples/real against the live sites (live Jev, --record all) and writes one report:
// scenarios passed, step outcomes, and every failure with its reason. Rerun after a fix to measure it.
// Usage: node scripts/corpus.ts [filter]   (filter: substring of the feature file name)
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "examples/real";
const PARALLEL = 3; // live sites and the Jev API: keep the load modest
const files = readdirSync(DIR).filter(f => f.endsWith(".feature") && f.includes(process.argv[2] ?? "")).sort();

interface Step { scenario: string; kind: string; step: string; outcome: string; reason?: string; seconds?: number; jevCalls?: number; inputTokens?: number; outputTokens?: number }
interface Result { file: string; run?: string; exit: number | null; steps: Step[]; scenarios: { name: string; passed: boolean }[]; error?: string }

function runFeature(file: string): Promise<Result> {
  return new Promise(resolve => {
    const child = spawn("node", ["src/cli.ts", "run", join(DIR, file), "--record", "all"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (out += d));
    child.on("close", exit => {
      const run = /Run directory: (\S+)/.exec(out)?.[1];
      const events = run ? readFileSync(join(run, "trace.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
      const scenarios = events.filter(e => e.type === "result").map(e => ({ name: e.scenario, passed: e.passed }));
      const steps = events.filter(e => e.type === "step").map(({ t, type, ...step }) => step as Step);
      // Infrastructure errors (exit 2) leave no step event: keep the console's last lines.
      const error = exit === 2 ? out.trim().split("\n").filter(l => /Error|Cannot|not set/.test(l)).slice(0, 2).join(" / ") : undefined;
      console.log(`${file}: exit ${exit}, ${scenarios.filter(s => s.passed).length}/${scenarios.length} scenarios`);
      resolve({ file, run, exit, steps, scenarios, error });
    });
  });
}

const results: Result[] = [];
const queue = [...files];
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  for (let f; (f = queue.shift()); ) results.push(await runFeature(f));
}));
results.sort((a, b) => a.file.localeCompare(b.file));

const steps = results.flatMap(r => r.steps.map(s => ({ ...s, file: r.file })));
const count = (xs: string[]) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
const passed = results.reduce((n, r) => n + r.scenarios.filter(s => s.passed).length, 0);
const total = results.reduce((n, r) => n + r.scenarios.length, 0);
// Cost and time: totals and the median Step (cassette replays cost 0; this script always calls Jev live).
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const metric = (name: string, pick: (s: Step) => number | undefined, digits = 0) => {
  const xs = steps.map(pick).filter((x): x is number => x !== undefined);
  return `| ${name} | ${xs.reduce((a, b) => a + b, 0).toFixed(digits)} | ${median(xs).toFixed(digits)} |`;
};
const report = [
  `# Real-site corpus, ${new Date().toISOString()}`,
  "",
  `Scenarios passed: ${passed}/${total}. Steps reached: ${steps.length}.`,
  "",
  "| Feature | Scenarios passed | Run directory |",
  "|---|---|---|",
  ...results.map(r => `| ${r.file} | ${r.scenarios.filter(s => s.passed).length}/${r.scenarios.length}${r.error ? ` (exit 2: ${r.error})` : ""} | ${r.run ?? "-"} |`),
  "",
  "## Cost and time",
  "",
  "| | Total | Median per step |",
  "|---|---|---|",
  metric("Jev calls", s => s.jevCalls),
  metric("Input tokens", s => s.inputTokens),
  metric("Output tokens", s => s.outputTokens),
  metric("Seconds", s => s.seconds, 1),
  "",
  "## Step outcomes",
  "",
  ...count(steps.map(s => s.outcome)).map(([o, n]) => `- ${o}: ${n}`),
  "",
  "## Failures",
  "",
  ...steps.filter(s => !["DONE", "PASSED", "JUDGED_PASSED"].includes(s.outcome))
    .map(s => `- **${s.outcome}** ${s.file} / ${s.scenario} / ${s.kind}: ${s.step}\n  ${(s.reason ?? "").replace(/\s+/g, " ").slice(0, 300)}`),
].join("\n");
const path = `runs/corpus-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
writeFileSync(path, report + "\n");
console.log(`\n${passed}/${total} scenarios passed. Report: ${path}`);
