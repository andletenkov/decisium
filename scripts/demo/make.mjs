// Records site/assets/demo.gif: a user writes a feature, runs it live (real Jev calls, records the cassette), then
// replays the cassette. Terminal on the left, browser on the right, both as they were at the same moment; nothing is
// added to either. Long waits are shortened to 1.5 s. Needs ffmpeg and TYPESAFE_API_KEY (or .env). Run: npm run demo
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const root = join(import.meta.dirname, "..", "..");
const tmp = "/tmp/decisium-demo";
const work = join(tmp, "project"); // an empty project: no cassette yet
rmSync(tmp, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const FEATURE = `@url:https://www.saucedemo.com/
Feature: Checkout

  Scenario: Checkout requires a first name, then completes
    When I log in as "standard_user" with password "secret_sauce"
    And I add "Sauce Labs Backpack" to the cart
    And I open the cart
    And I start the checkout
    And I try to continue without filling in the form
    Then the error should say "First Name is required"
    When I enter "Ada" as first name, "Lovelace" as last name and "10115" as postal code
    And I continue
    Then the item total should be "$29.99"
    When I finish the order
    Then the confirmation should say "Thank you for your order!"`;

/** A frame: terminal lines, the browser screenshot (or none), seconds shown. */
const frames = [];
let term = [];
let shot = null;
const show = (seconds) => frames.push({ term: [...term], shot, seconds });

/** Part 1: the user types the feature into a file. */
function write() {
  term = ["$ cat > checkout.feature"];
  show(0.8);
  for (const line of FEATURE.split("\n")) {
    term.push(line);
    show(line.trim() ? 0.35 : 0.1);
  }
  term.push("^D");
  show(1.2);
  writeFileSync(join(work, "checkout.feature"), `${FEATURE}\n`);
}

/** Parts 2 and 3: a real `decisium run` in the project; frames follow its output lines and screenshots. */
async function run(flags, n) {
  const shown = `decisium run checkout.feature ${flags.join(" ")}`.trim();
  term = ["$ clear", `$ ${shown}`];
  show(1);
  const raw = join(tmp, `shots-${n}`);
  const lines = [];
  const env = { ...process.env, DEMO_FRAMES: raw };
  const envFile = join(root, ".env");
  const node = existsSync(envFile) ? ["--env-file", envFile] : [];
  await new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [
        ...node,
        join(root, "src/cli.ts"),
        "run",
        "checkout.feature",
        ...flags,
        "--import",
        join(import.meta.dirname, "hooks.mjs"),
      ],
      { cwd: work, env },
    );
    let buf = "";
    const onData = (d) => {
      buf += d;
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const text of parts) lines.push({ text, t: Date.now() });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on(
      "close",
      (code) => (
        buf && lines.push({ text: buf, t: Date.now() }),
        code > 1 ? reject(new Error(`exit ${code}:\n${lines.map((l) => l.text).join("\n")}`)) : resolve()
      ),
    );
  });
  const shots = readFileSync(join(raw, "frames.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const events = [
    ...lines.map((l) => ({ t: l.t, line: l.text })),
    ...shots.map((s) => ({ t: s.t, file: s.file })),
  ].sort((a, b) => a.t - b.t);
  const out = lines.map((l) => l.text).join("\n");
  if (!/1\/1 scenarios passed/.test(out) || / 0 recorded/.test(out) !== flags.includes("none") || /marginal/.test(out))
    throw new Error(`not a clean take:\n${out}`);
  let last = null;
  for (const [i, e] of events.entries()) {
    if (e.line !== undefined) term.push(e.line);
    else {
      const bytes = readFileSync(e.file);
      if (last && bytes.equals(last)) continue; // the page did not change: no new frame
      last = bytes;
      shot = e.file;
    }
    const next = events[i + 1];
    show(next ? Math.min(Math.max((next.t - e.t) / 1000, 0.1), 1.5) : 3);
  }
}

write();
// Live: real Jev calls, writes checkout.cassette.json. A live run can differ from run to run; retake until clean.
const before = { frames: frames.length, term };
for (let take = 1; ; take++) {
  try {
    await run(["--headed"], take);
    break;
  } catch (e) {
    if (take === 3) throw e;
    console.error(e.message);
    frames.length = before.frames;
    term = before.term;
    rmSync(join(work, "checkout.cassette.json"), { force: true });
  }
}
shot = null;
await run(["--record", "none", "--headed"], "replay"); // replay: no model calls
frames.at(-1).seconds = 5;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const html = (f) => `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;width:1280px;height:640px;background:#000;display:flex;gap:16px;padding:16px;box-sizing:border-box}
  pre{margin:0;width:560px;height:100%;flex:none;color:#d0d0d0;font:12.5px/1.6 Menlo,monospace;white-space:pre-wrap;overflow:hidden}
  img{flex:1;min-width:0;align-self:flex-start;width:100%}
  </style><pre>${esc(f.term.join("\n"))}</pre>${f.shot ? `<img src="data:image/png;base64,${readFileSync(f.shot).toString("base64")}">` : ""}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
const list = [];
for (const [i, f] of frames.entries()) {
  const file = join(tmp, `${String(i).padStart(4, "0")}.png`);
  await page.setContent(html(f));
  await page.$eval("pre", (pre) => (pre.scrollTop = pre.scrollHeight)); // a full terminal scrolls
  await page.screenshot({ path: file });
  list.push(`file '${file}'\nduration ${f.seconds}`);
}
await browser.close();
list.push(list.at(-1).split("\n")[0]); // concat needs the last frame twice
writeFileSync(join(tmp, "list.txt"), `${list.join("\n")}\n`);

const gif = join(root, "site/assets/demo.gif");
const filter =
  "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4";
execFileSync("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  join(tmp, "list.txt"),
  "-vf",
  filter,
  gif,
]);
console.log(`wrote ${gif}: ${frames.length} frames, ${frames.reduce((s, f) => s + f.seconds, 0).toFixed(1)} s`);
