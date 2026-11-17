import assert from "node:assert/strict";
import { test } from "node:test";
import { Browser } from "../src/browser.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunDir } from "../src/trace.ts";
import { runStep } from "../src/runner.ts";

test("Runtime Action step dismisses dialogs on errors, retains the message, and forgets it at the next Action step", async () => {
  const b = await Browser.open(
    `data:text/html,<p id=o>waiting</p><button onclick="o.textContent=confirm('Delete?')?'deleted':'kept'">Delete</button>`,
  );
  const error = new Error("decision service unavailable");
  const lines: string[] = [];
  try {
    await assert.rejects(
      b.actionStep(
        async () => {
          const obs = await b.observe();
          await b.execute({ verb: "CLICK", ref: obs.elements[0].ref });
          assert.equal((await b.observe()).dialog?.state, "open");
          throw error;
        },
        (line) => {
          lines.push(line);
        },
      ),
      (e) => e === error,
    );
    const obs = await b.observe();
    assert.equal(obs.dialog?.state, "dismissed");
    assert.equal(obs.dialog?.message, "Delete?");
    assert.match(obs.pageText, /kept/);
    assert.match(lines.join("\n"), /was still open when the Step ended: dismissed/);
    assert.equal(
      await b.actionStep(
        async () => {
          assert.equal((await b.observe()).dialog, undefined);
          return "done";
        },
        () => {},
      ),
      "done",
    );
  } finally {
    await b.close();
  }
});

test("traced Runtime brackets named-key steps and records cleanup without exposing secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-"));
  const b = await Browser.open(
    `data:text/html,<button autofocus onclick="confirm('PIN 4321?');alert('Cancelled')">Open</button>`,
    false,
    false,
    { $PIN: "4321" },
  );
  const dir = new RunDir(root);
  dir.scenario("cleanup");
  const unexpected = async () => {
    throw new Error("decision model should not be called");
  };
  try {
    const rt = dir.runtime(b);
    const result = await runStep(
      "I press Enter",
      rt,
      {
        turn: unexpected,
        value: unexpected,
        assess: unexpected,
        recall: unexpected,
        dialog: unexpected,
        drop: unexpected,
      },
      (line) => dir.log(line),
    );
    assert.equal(result.outcome, "DONE");
    assert.equal(
      (await rt.observe()).dialog?.state,
      "dismissed",
      "cleanup also dismisses a dialog opened by cancelling the first",
    );
    dir.flush();
    const trace = readFileSync(join(dir.path, "trace.jsonl"), "utf8");
    assert.deepEqual(
      trace
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((e) => e.type === "execute")
        .map((e) => e.verb),
      ["PRESS", "DISMISS", "DISMISS"],
    );
    const log = readFileSync(join(dir.path, "log.txt"), "utf8");
    assert.match(log, /PIN \$PIN\?/);
    assert.ok(!trace.includes("4321") && !log.includes("4321"));
  } finally {
    await b.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("describeFailure: credentials in the query are masked, long URLs capped", async () => {
  const { describeFailure } = await import("../src/runner.ts");
  assert.equal(
    describeFailure({ request: "GET https://x/q?a=1&x-algolia-api-key=abc&access_token=t", status: 500 }),
    "GET https://x/q?a=1&x-algolia-api-key=***&access_token=*** -> 500",
  );
  const long = describeFailure({ request: `GET https://x/${"a".repeat(300)}`, error: "net::ERR_FAILED" });
  assert.match(long, /^GET https:\/\/x\/a+… -> net::ERR_FAILED$/);
  assert.equal(long.length, 200 + " -> net::ERR_FAILED".length);
});

test("blockedBy: failed requests that split Jev's confidence still block the Step; the strongest outcome names it", async () => {
  const { blockedBy } = await import("../src/runner.ts");
  const r = (path: string, status?: number) =>
    status === undefined
      ? { request: `GET https://agent/${path}`, error: "net::ERR_FAILED" }
      : { request: `GET https://agent/${path}`, status };
  const pick = (probabilities: Record<string, number>) => ({ choice: "r0", probabilities });
  // As seen behind a gateway that answers 429 without CORS headers: three agent GETs, none of them above 51%.
  const three = [r("agents"), r("agents/42"), r("agents/42/runs")];
  const split = blockedBy(pick({ r0: 0.51, r1: 0.25, r2: 0.18, none: 0.06 }), three);
  assert.equal(split?.outcome, "NETWORK_ERROR");
  assert.deepEqual(split?.requests, three);
  // Mixed kinds: the outcome holding most of the confidence wins, its requests likeliest first.
  const mixed = [r("a", 429), r("b"), r("c", 429)];
  const m = blockedBy(pick({ r0: 0.3, r1: 0.25, r2: 0.35, none: 0.1 }), mixed);
  assert.equal(m?.outcome, "RATE_LIMITED");
  assert.deepEqual(m?.requests, [mixed[2], mixed[0]]);
  // Not the Step's requests, or not sure enough that they are: the Step keeps its outcome.
  assert.equal(blockedBy(pick({ r0: 0.3, none: 0.7 }), [r("beacon")]), undefined);
  assert.equal(blockedBy(pick({ r0: 0.4, r1: 0.35, none: 0.25 }), [r("a", 500), r("b", 500)]), undefined);
});
