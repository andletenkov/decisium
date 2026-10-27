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
import { runAssertion } from "../src/runner.ts";
import { RunDir } from "../src/trace.ts";

const PAGE = `<input aria-label=name oninput="clearTimeout(window.d);d=setTimeout(()=>fetch('/ok').then(()=>v.textContent='valid'),50)"><p id=v></p><button onclick="fetch('/hang',{method:'POST'});fetch('/ok').then(()=>o.textContent='done')">Go</button>
<button id=img onclick="document.body.append(Object.assign(new Image(),{src:'/slow.png'}))">Img</button><p id=o>idle</p>`;
let server: Server;
let url: string;
const hung: (() => void)[] = [];

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/hang" || req.url === "/slow.png")
      hung.push(() => res.end()); // never answered during the test
    else if (req.url === "/ok") res.end("ok");
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

test("replay: typing does not settle; live typing does", async () => {
  assert.equal((await timed(true, "TYPE", "name")).perf["after:TYPE"], undefined);
  assert.notEqual((await timed(false, "TYPE", "name")).perf["after:TYPE"], undefined);
});

test("perf tally splits settle by what held it", async () => {
  const { perf } = await timed(true, "CLICK", "Go");
  assert.ok((perf["settle:requests:fetch"] ?? 0) > 0 && perf["after:CLICK"] > 0 && perf["perform:CLICK"] >= 0);
});

test("replay: a check after typing sees what the typing triggered (it settles first)", async () => {
  const b = await Browser.open(url);
  b.replay = true;
  const rt = new RunDir(mkdtempSync(join(tmpdir(), "perf-"))).runtime(b);
  try {
    const obs = await rt.observe();
    await rt.execute({ verb: "TYPE", ref: obs.elements.find((e) => e.name === "name")!.ref, value: "x" });
    let seen = "";
    const spy = {
      assess: async (_s: string, o: { pageText: string }) => {
        seen = o.pageText;
        throw new Error("stop");
      },
    } as unknown as Decider;
    await assert.rejects(
      runAssertion('"valid" is shown', rt, spy, () => {}),
      /stop/,
    );
    assert.match(seen, /valid/, "the check observed the page before the debounced validation landed");
  } finally {
    await b.close();
  }
});
