// Replay-speed regressions (issue #2). Generous bounds against a local server: they fail on the old behaviour by seconds.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browser } from "../src/browser.ts";
import type { Decider } from "../src/decision.ts";
import { runAssertion, runStep } from "../src/runner.ts";
import { RunDir } from "../src/trace.ts";

const PAGE = `<input aria-label=name oninput="clearTimeout(window.d);d=setTimeout(()=>fetch('/ok').then(()=>v.textContent='valid'),50)"><p id=v></p><button onclick="fetch('/hang',{method:'POST'});fetch('/ok').then(()=>o.textContent='done')">Go</button>
<button id=img onclick="document.body.append(Object.assign(new Image(),{src:'/slow.png'}))">Img</button><p id=o>idle</p>
<button onclick="setTimeout(()=>o.textContent='later',30)">Later</button>
<button onclick="fetch('/slow').then(()=>o.textContent='loaded')">Load</button>`;
let server: Server;
let url: string;
const hung: (() => void)[] = [];

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/hang" || req.url === "/slow.png")
      hung.push(() => res.end()); // never answered during the test
    else if (req.url === "/ok") res.end("ok");
    else if (req.url === "/slow") setTimeout(() => res.end("ok"), 300);
    else res.setHeader("content-type", "text/html").end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
after(() => {
  for (const end of hung) end();
  server.closeAllConnections();
  server.close();
});

/** Runs `verb` on the element named `name` and returns how long execute() took and the Browser's perf tally. */
async function timed(replay: boolean, verb: "CLICK" | "TYPE", name: string) {
  const b = await Browser.open(url);
  b.replay = replay;
  try {
    const obs = await b.observe();
    const el = obs.elements.find((e) => e.name === name)!;
    const t = Date.now();
    await b.execute({ verb, ref: el.ref, value: verb === "TYPE" ? "x" : undefined });
    return { ms: Date.now() - t, perf: { ...b.perf } };
  } finally {
    await b.close();
  }
}

test("replay: a request that never answers does not hold the action for the settle cap", async () => {
  const { ms } = await timed(true, "CLICK", "Go");
  assert.ok(ms < 3000, `click took ${ms} ms; a hung request must stop holding settle after ~1.5 s`);
});

test("images and other non-rendering requests never hold settle, live or replay", async () => {
  for (const replay of [false, true]) {
    const { ms } = await timed(replay, "CLICK", "Img");
    assert.ok(ms < 1500, `click took ${ms} ms (replay=${replay}); a slow image must not hold settle`);
  }
});

test("replay: actions do not wait for the page to settle (like a Playwright spec); live ones do", async () => {
  for (const [verb, name] of [
    ["TYPE", "name"],
    ["CLICK", "Load"],
  ] as const) {
    assert.equal((await timed(true, verb, name)).perf[`after:${verb}`], undefined);
    assert.notEqual((await timed(false, verb, name)).perf[`after:${verb}`], undefined);
  }
});

test("perf tally splits settle by what held it", async () => {
  const { perf } = await timed(false, "CLICK", "Load");
  assert.ok((perf["settle:requests:fetch"] ?? 0) > 0 && perf["after:CLICK"] > 0 && perf["perform:CLICK"] >= 0);
});

const sure = (choice: string) => ({ choice, probabilities: { [choice]: 1 } });
/** Reads a presence check of the whole page, as Jev would for `"x" should appear`. */
const presence = {
  assess: async () => ({ kind: sure("presence"), subject: sure("none"), area: sure("page"), state: sure("disabled") }),
} as unknown as Decider;

test("replay: a check retries until what the last action triggered lands, like expect()", async () => {
  const b = await Browser.open(url);
  b.replay = true;
  const rt = new RunDir(mkdtempSync(join(tmpdir(), "perf-"))).runtime(b);
  try {
    let obs = await rt.observe();
    await rt.execute({ verb: "TYPE", ref: obs.elements.find((e) => e.name === "name")!.ref, value: "x" });
    assert.equal((await runAssertion('"valid" should appear', rt, presence, () => {})).outcome, "PASSED");
    obs = await rt.observe();
    await rt.execute({ verb: "CLICK", ref: obs.elements.find((e) => e.name === "Load")!.ref });
    assert.equal((await runAssertion('"loaded" should appear', rt, presence, () => {})).outcome, "PASSED");
    assert.equal((await runAssertion('"never" should appear', rt, presence, () => {})).outcome, "ASSERTION_FAILED");
  } finally {
    await b.close();
  }
});

test("replay: an effect that lands a task after the click still counts as the action's effect", async () => {
  const b = await Browser.open(url);
  b.replay = true;
  const rt = new RunDir(mkdtempSync(join(tmpdir(), "perf-"))).runtime(b);
  const seen: string[][] = [];
  const decider = {
    turn: async (_s: string, obs: { elements: { ref: string; name: string }[] }, recent: string[]) => {
      seen.push([...recent]);
      const ref = obs.elements.find((e) => e.name === "Later")!.ref;
      return recent.length
        ? { done: 0.99, target: sure("none") }
        : { done: 0.01, target: sure(ref), action: sure("click") };
    },
  } as unknown as Decider;
  try {
    assert.equal((await runStep("I press Later", rt, decider, () => {})).outcome, "DONE");
    assert.doesNotMatch(seen[1][0], /no visible change/);
  } finally {
    await b.close();
  }
});
