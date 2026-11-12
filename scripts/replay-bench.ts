// Replay speed (issue #2): the same scenario as a hand-written Playwright script, as a Decisium cassette replay
// (`--record none`) and, with --live, as a live recording (`--record all`; calls Jev, needs TYPESAFE_API_KEY).
// Runs against the campaign-manager fixture with its artificial API latency, so every mode waits for the same requests.
//
// Usage: node scripts/replay-bench.ts [--runs 3] [--latency 100] [--live] [--json out.json]
// Verdict: the median scenario time of the replay divided by the Playwright script's must be <= THRESHOLD at the default
// 100 ms API latency (a typical backend), else the docs must not call replay "fast". The overhead is mostly a fixed
// cost per scenario and per Step, so with --latency 0 the ratio is higher: read the overhead line too. Scenario time includes opening and closing the browser in both (Decisium opens a
// fresh browser per scenario); process start-up is reported separately because a suite pays it once.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const THRESHOLD = 1.5;
const root = join(import.meta.dirname, "..");
const FIXTURE = join(root, "test/fixtures/campaign-manager");
const SCENARIO_LINE = 5; // "Create, schedule and find a campaign in the calendar": 9 Steps over 4 screens

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) =>
  (args.includes(name) ? args[args.indexOf(name) + 1] : undefined) ?? fallback;

/** The scenario written the way a Playwright user would: roles, labels, auto-waiting, no fixed sleeps. */
async function playwrightScenario(url: string) {
  const { chromium } = await import("playwright");
  const t0 = Date.now();
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "New campaign" }).click();
  await page.getByLabel("Campaign name").fill("Winter Sale");
  await page.getByLabel("Activation date").fill("2026-12-01");
  await page.getByLabel("Activation period").selectOption("2 weeks");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.locator("#status", { hasText: /^Draft$/ }).waitFor();
  await page.getByRole("button", { name: "Schedule" }).click();
  await page.locator("#status", { hasText: /^Scheduled$/ }).waitFor();
  await page.waitForFunction(() => (document.getElementById("schedule") as HTMLButtonElement).disabled);
  await page.getByRole("link", { name: "Calendar" }).click();
  await page.getByText("Winter Sale").waitFor();
  await browser.close();
  console.log(JSON.stringify({ scenarioMs: Date.now() - t0 }));
}

if (args[0] === "--pw") {
  await playwrightScenario(args[1]);
  process.exit(0);
}

process.env.LATENCY_MS = opt("--latency", "100");
const { start } = await import("../test/fixtures/campaign-manager/server.ts");
const { url, close } = await start(0);
const startUrl = `${url}?reset=1`;

interface Sample {
  wallMs: number;
  scenarioMs: number;
  perf?: Record<string, number>;
  jevCalls?: number;
}

function run(cmd: string[]): Promise<{ out: string; wallMs: number }> {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const child = spawn(process.execPath, cmd, { cwd: root, env: process.env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) =>
      code === 0
        ? resolve({ out, wallMs: Date.now() - t })
        : reject(new Error(`${cmd.join(" ")} exited ${code}\n${out}`)),
    );
  });
}

async function playwright(): Promise<Sample> {
  const { out, wallMs } = await run([join(root, "scripts/replay-bench.ts"), "--pw", startUrl]);
  return { wallMs, scenarioMs: JSON.parse(out.trim().split("\n").at(-1)!).scenarioMs };
}

/** A fresh copy of the fixture feature and its cassette, so --record all never rewrites the committed one. */
async function decisium(record: "none" | "all"): Promise<Sample> {
  const dir = mkdtempSync(join(tmpdir(), "replay-bench-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const { wallMs } = await run([
    join(root, "src/cli.ts"),
    "run",
    `${join(dir, "campaigns.feature")}:${SCENARIO_LINE}`,
    "--url",
    startUrl,
    "--record",
    record,
    "--report-dir",
    join(dir, "runs"),
  ]);
  const runDir = join(dir, "runs", readdirSync(join(dir, "runs"))[0]);
  const events = readFileSync(join(runDir, "trace.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const begin = events.find((e) => e.type === "scenario");
  const end = events.find((e) => e.type === "result");
  const steps = events.filter((e) => e.type === "step");
  return {
    wallMs,
    scenarioMs: Date.parse(end.t) - Date.parse(begin.t),
    perf: end.perf,
    jevCalls: steps.reduce((n, s) => n + (s.jevCalls ?? 0), 0),
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const runs = Number(opt("--runs", "3"));
const modes: [string, () => Promise<Sample>][] = [
  ["Playwright script", playwright],
  ["Decisium replay (--record none)", () => decisium("none")],
];
if (args.includes("--live")) modes.push(["Decisium live (--record all)", () => decisium("all")]);

// Warm-up: the first browser launch after install is slower and would land on one mode only.
await playwright();
const results: Record<string, Sample[]> = {};
try {
  for (const [name, fn] of modes) {
    results[name] = [];
    for (let i = 0; i < runs; i++) results[name].push(await fn());
  }
} finally {
  close();
}

const seconds = (ms: number) => (ms / 1000).toFixed(2).padStart(5);
console.log(`\nCampaign-manager scenario, ${runs} runs each, API latency ${process.env.LATENCY_MS} ms\n`);
console.log("| Mode | Scenario time (s) | Process wall (s) |\n|---|---|---|");
for (const [name, samples] of Object.entries(results))
  console.log(
    `| ${name} | ${samples.map((s) => seconds(s.scenarioMs)).join(" ")} (median ${seconds(median(samples.map((s) => s.scenarioMs)))}) | ${samples.map((s) => seconds(s.wallMs)).join(" ")} (median ${seconds(median(samples.map((s) => s.wallMs)))}) |`,
  );

const replay = results["Decisium replay (--record none)"];
console.log("\nReplay time by method, last run (ms):");
console.log(
  Object.entries(replay.at(-1)!.perf ?? {})
    .filter(([, v]) => v >= 20)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${k.padEnd(24)} ${v}`)
    .join("\n"),
);

const ratio = median(replay.map((s) => s.scenarioMs)) / median(results["Playwright script"].map((s) => s.scenarioMs));
const overhead =
  median(replay.map((s) => s.scenarioMs)) - median(results["Playwright script"].map((s) => s.scenarioMs));
console.log(`\nReplay overhead over Playwright: ${(overhead / 1000).toFixed(2)} s per scenario`);
console.log(
  `Replay / Playwright (scenario time): ${ratio.toFixed(2)}x, threshold ${THRESHOLD}x: ${ratio <= THRESHOLD ? "OK" : "OVER"}`,
);
// A replay that asks Jev measures Jev, not replay: a page still loading must be waited for, not healed (issue #90).
const calls = replay.reduce((n, s) => n + (s.jevCalls ?? 0), 0);
console.log(`Jev calls during replay: ${calls}, expected 0: ${calls === 0 ? "OK" : "FAIL"}`);
if (args.includes("--json"))
  writeFileSync(opt("--json", "replay-bench.json"), JSON.stringify({ ratio, THRESHOLD, calls, results }, null, 2));
process.exit(ratio <= THRESHOLD && calls === 0 ? 0 : 1);
