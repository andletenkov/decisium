// Captures timestamped browser screenshots of a real run for the demo GIF.
// Used by scripts/demo/make.mjs via `decisium run --import`.
import { AfterStep, BeforeStep } from "@cucumber/cucumber";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.DEMO_FRAMES;
mkdirSync(dir, { recursive: true });
let n = 0,
  timer;

async function shot(page) {
  const file = join(dir, `${String(n++).padStart(4, "0")}.png`);
  try {
    await page.screenshot({ path: file });
    appendFileSync(join(dir, "frames.jsonl"), JSON.stringify({ file, t: Date.now() }) + "\n");
  } catch {}
}

BeforeStep(async function () {
  await shot(this.page);
  timer = setInterval(() => shot(this.page), 250);
});

AfterStep(async function () {
  clearInterval(timer);
  await shot(this.page);
});
