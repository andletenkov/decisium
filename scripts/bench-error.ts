// Benchmark for the app-error question (runner.ts shownError, Decider.error): asked only when an Action step is
// about to fail and no ARIA alert with text states the error. Labelled failing pages: errors in any element and
// language (Jev should pick them) and pages that just lack the Step's control (Jev should say none).
// Reports accuracy (right, and confidently wrong: the costly kind, it relabels a failure), cost per call, and how
// often recent runs would ask (runs/*/trace.jsonl).
// Usage: node --env-file=.env scripts/bench-error.ts [--repeat 3] [--concurrency 4]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gate } from "../src/decision.ts";
import { JevDecider, jevUsage } from "../src/jev.ts";
import { parseSnapshot } from "../src/observation.ts";

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const REPEAT = arg("repeat", 3);
const CONCURRENCY = arg("concurrency", 4);

/** `error`: the ref Jev should pick, or "none". */
const CASES: { name: string; step: string; page: string[]; error: string }[] = [
  {
    name: "load error paragraph + empty alert (issue)",
    step: "I edit the record",
    page: [
      '- heading "Record" [level=1] [ref=e1]',
      "- paragraph [ref=e2]: Could not load this record",
      "- alert [ref=e3]",
      '- link "Back" [ref=e4]',
    ],
    error: "e2",
  },
  {
    name: "generic crash heading",
    step: "I open the campaign settings",
    page: [
      '- heading "Something went wrong" [level=2] [ref=e1]',
      "- paragraph [ref=e2]: Please try again later.",
      '- button "Retry" [ref=e3]',
    ],
    error: "e1",
  },
  {
    name: "HTTP 500 text",
    step: "I delete the second invoice",
    page: [
      '- navigation "Main" [ref=e1]:\n  - link "Invoices" [ref=e2]',
      "- generic [ref=e3]: 500 Internal Server Error",
      '- link "Home" [ref=e4]',
    ],
    error: "e3",
  },
  {
    name: "permission denied",
    step: "I change the user role to Admin",
    page: [
      '- heading "Users" [level=1] [ref=e1]',
      "- paragraph [ref=e2]: You do not have permission to view this page.",
      '- link "Dashboard" [ref=e3]',
    ],
    error: "e2",
  },
  {
    name: "German load error",
    step: "Ich bearbeite den Kunden",
    page: [
      '- heading "Kunde" [level=1] [ref=e1]',
      "- paragraph [ref=e2]: Der Kunde konnte nicht geladen werden.",
      '- link "Zurück" [ref=e3]',
    ],
    error: "e2",
  },
  {
    name: "Russian network error",
    step: "Я открываю заказ 42",
    page: [
      '- heading "Заказы" [level=1] [ref=e1]',
      "- status [ref=e2]: Ошибка сети. Не удалось загрузить заказы.",
      '- button "Повторить" [ref=e3]',
    ],
    error: "e2",
  },
  {
    name: "toast error in a region",
    step: "I save the profile",
    page: [
      '- region "Notifications" [ref=e1]:\n  - paragraph [ref=e2]: Request failed: timeout',
      '- heading "Profile" [level=1] [ref=e3]',
      '- link "Back" [ref=e4]',
    ],
    error: "e2",
  },
  {
    name: "no error: control simply missing",
    step: "I archive the project",
    page: [
      '- heading "Project Apollo" [level=1] [ref=e1]',
      "- paragraph [ref=e2]: Created 3 days ago",
      '- button "Edit" [ref=e3]',
      '- button "Share" [ref=e4]',
    ],
    error: "none",
  },
  {
    name: "no error: empty state",
    step: "I open the first order",
    page: [
      '- heading "Orders" [level=1] [ref=e1]',
      "- paragraph [ref=e2]: No orders yet.",
      '- button "New order" [ref=e3]',
    ],
    error: "none",
  },
  {
    name: "no error: wrong page",
    step: "I add the backpack to the cart",
    page: [
      '- heading "Your cart" [level=1] [ref=e1]',
      "- listitem [ref=e2]: Bike light $9.99",
      '- button "Checkout" [ref=e3]',
      '- button "Continue shopping" [ref=e4]',
    ],
    error: "none",
  },
  {
    name: "no error: empty alert only",
    step: "I schedule the campaign",
    page: ['- heading "Campaign" [level=1] [ref=e1]', "- alert [ref=e2]", '- button "Save draft" [ref=e3]'],
    error: "none",
  },
  {
    name: "no error: unrelated warning text",
    step: "I export the report as PDF",
    page: [
      '- heading "Report" [level=1] [ref=e1]',
      "- paragraph [ref=e2]: Figures are not audited.",
      '- button "Export CSV" [ref=e3]',
    ],
    error: "none",
  },
];

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
}

/** Median live Step, and how often an Action step ends in an outcome that asks (without an alert check: an upper bound). */
function baseline() {
  const secs: number[] = [];
  let actions = 0,
    asking = 0;
  const dir = process.env.RUNS ?? "runs";
  for (const d of existsSync(dir) ? readdirSync(dir) : []) {
    const p = join(dir, d, "trace.jsonl");
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.includes('"step"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type !== "step") continue;
        if (e.jevCalls > 0 && e.seconds) secs.push(e.seconds);
        if (e.kind === "assertion" || ["PASSED", "ASSERTION_FAILED", "UNVERIFIABLE"].includes(e.outcome)) continue;
        actions++;
        if (["AMBIGUOUS", "BLOCKED", "ELEMENT_NOT_FOUND", "STEP_TIMEOUT"].includes(e.outcome)) asking++;
      } catch {}
    }
  }
  return { steps: secs.length, stepS: pct(secs, 50), actions, asking };
}

const jev = new JevDecider();
const jobs = CASES.flatMap((c) => Array.from({ length: REPEAT }, () => c));
const results: { name: string; ok: boolean; wrongSure: boolean; ms: number; inT: number; outT: number }[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const c = jobs[next++];
      const obs = parseSnapshot(c.page.join("\n"));
      const before = { ...jevUsage },
        t0 = performance.now();
      const pick = await jev.error(c.step, obs);
      const ms = performance.now() - t0;
      const sure = pick.choice !== "none" && gate(pick);
      const got = sure ? pick.choice : "none";
      results.push({
        name: c.name,
        ok: got === c.error,
        wrongSure: sure && got !== c.error,
        ms,
        // Concurrent calls share jevUsage: approximate under concurrency > 1.
        inT: jevUsage.inputTokens - before.inputTokens,
        outT: jevUsage.outputTokens - before.outputTokens,
      });
    }
  }),
);

const lines = ["# App-error question benchmark", "", "| Case | right | confidently wrong |", "|---|---|---|"];
for (const c of CASES) {
  const rs = results.filter((r) => r.name === c.name);
  lines.push(`| ${c.name} | ${rs.filter((r) => r.ok).length}/${rs.length} | ${rs.filter((r) => r.wrongSure).length} |`);
}
const b = baseline();
const ms = results.map((r) => r.ms);
lines.push(
  "",
  `- Right: ${results.filter((r) => r.ok).length}/${results.length}; confidently wrong: ${results.filter((r) => r.wrongSure).length}`,
  `- Per call: p50 ${(pct(ms, 50) / 1000).toFixed(2)} s, p90 ${(pct(ms, 90) / 1000).toFixed(2)} s; tokens in ~${pct(
    results.map((r) => r.inT),
    50,
  )}, out ~${pct(
    results.map((r) => r.outT),
    50,
  )}`,
  `- Live Step (${b.steps} from runs/): median ${b.stepS.toFixed(2)} s; one call adds +${((100 * pct(ms, 50)) / 1000 / (b.stepS || 1)).toFixed(0)}% to a failing Step`,
  `- Asked on ${b.asking}/${b.actions} Action steps in runs/ (${((100 * b.asking) / (b.actions || 1)).toFixed(1)}%, upper bound: alerts with text skip it); passing Steps and replays: +0`,
);
console.log(lines.join("\n"));
