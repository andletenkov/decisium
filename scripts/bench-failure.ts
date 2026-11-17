// Benchmark for Jev's failed-request question (Decider.failure, runner.ts blockingFailure): asked only when a blocked
// Action step's page has failed requests that can leave it incomplete (5xx, 429, no response).
// Cases: scripts/failure-cases.json, real pages saved by scripts/error-sites.ts --save. `needed`: the requests the
// Step needs (any is right); empty: none is (a tracker on a dead host, a data request the Step does not need).
// Reports accuracy (confidently wrong is the costly kind: it relabels a failure) and the cost per call.
// Usage: node --env-file=.env scripts/bench-failure.ts [--repeat 3] [--concurrency 4]
import { readFileSync } from "node:fs";
import { JevDecider, jevUsage } from "../src/jev.ts";
import { parseSnapshot, withPage } from "../src/observation.ts";
import { blockedBy, type FailedRequest } from "../src/runner.ts";

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const REPEAT = arg("repeat", 3);
const CONCURRENCY = arg("concurrency", 4);

interface Case {
  site: string;
  kind: string;
  step: string;
  url: string;
  snapshot: string;
  failed: string[];
  needed: string[];
}
const cases: Case[] = JSON.parse(readFileSync("scripts/failure-cases.json", "utf8"));
const jev = new JevDecider();
const jobs = cases.flatMap((c) => Array.from({ length: REPEAT }, () => c));
type Verdict = "right" | "missed" | "wrong";
const results: { c: Case; verdict: Verdict; ms: number; inT: number; outT: number; top: string }[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const c = jobs[next++];
      const obs = c.snapshot.startsWith("- page ")
        ? parseSnapshot(c.snapshot)
        : withPage(parseSnapshot(c.snapshot), c.url, c.site);
      const before = { ...jevUsage },
        t0 = performance.now();
      const pick = await jev.failure(c.step, obs, c.failed);
      const ms = performance.now() - t0;
      // As the runner reads it: blocked by the failures at all, and which request names it first.
      const failed: FailedRequest[] = c.failed.map((line) => {
        const [request, result] = line.split(" -> ");
        return /^\d+$/.test(result) ? { request, status: Number(result) } : { request, error: result };
      });
      const blocked = blockedBy(pick, failed);
      const chosen = blocked && c.failed[failed.indexOf(blocked.requests[0])];
      const verdict: Verdict = chosen
        ? c.needed.includes(chosen)
          ? "right"
          : "wrong"
        : c.needed.length
          ? "missed"
          : "right";
      results.push({
        c,
        verdict,
        ms,
        // Concurrent calls share jevUsage: approximate under concurrency > 1.
        inT: jevUsage.inputTokens - before.inputTokens,
        outT: jevUsage.outputTokens - before.outputTokens,
        top: `${pick.choice}=${(pick.probabilities[pick.choice] ?? 0).toFixed(2)}`,
      });
    }
  }),
);

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
}
const lines = [
  "# Failed-request question benchmark",
  "",
  "| Case | Step | right | missed | wrong | answers |",
  "|---|---|---|---|---|---|",
];
for (const c of cases) {
  const rs = results.filter((r) => r.c === c);
  const n = (v: Verdict) => rs.filter((r) => r.verdict === v).length;
  lines.push(
    `| ${c.kind} ${c.site} | ${c.step} | ${n("right")} | ${n("missed")} | ${n("wrong")} | ${rs.map((r) => r.top).join(" ")} |`,
  );
}
const count = (v: Verdict, needed: boolean) =>
  results.filter((r) => r.verdict === v && !!r.c.needed.length === needed).length;
const ms = results.map((r) => r.ms);
lines.push(
  "",
  `- Needed request present: right ${count("right", true)}, missed ${count("missed", true)}, wrong request ${count("wrong", true)} (of ${results.filter((r) => r.c.needed.length).length})`,
  `- None needed: right ${count("right", false)}, confidently wrong ${count("wrong", false)} (of ${results.filter((r) => !r.c.needed.length).length})`,
  `- Per call: p50 ${(pct(ms, 50) / 1000).toFixed(2)} s, p90 ${(pct(ms, 90) / 1000).toFixed(2)} s; tokens in ~${pct(
    results.map((r) => r.inT),
    50,
  )}, out ~${pct(
    results.map((r) => r.outT),
    50,
  )}`,
);
console.log(lines.join("\n"));
