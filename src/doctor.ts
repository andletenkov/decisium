// `decisium doctor`: the setup checks a CI job wants before the first run, one [OK]/[FAIL] line each.
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import { Browser } from "./browser.ts";
import { parseFeature, toUrl, type Scenario } from "./feature.ts";
import { MODEL } from "./jev.ts";

/** Node with type stripping on by default: the CLI runs .ts files directly. */
export const nodeOk = (version = process.versions.node) => {
  const [major, minor] = version.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
};

export async function doctor(files: string[]): Promise<number> {
  let failed = false;
  const line = (ok: boolean, what: string) => {
    failed ||= !ok;
    console.log(`[${ok ? "OK" : "FAIL"}] ${what}`);
  };
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      line(true, what);
    } catch (err) {
      line(false, `${what}: ${(err as Error).message.split("\n")[0]}`);
    }
  };

  line(nodeOk(), `Node ${process.versions.node} (needs 22.18+ or 23.6+)`);
  line(existsSync(chromium.executablePath()), `Chromium at ${chromium.executablePath()} (else: decisium install)`);
  if (!process.env.TYPESAFE_API_KEY) line(false, "TYPESAFE_API_KEY is not set");
  else
    await attempt(`TYPESAFE_API_KEY accepted by Jev (${MODEL})`, () =>
      new TypeSafeClient({ defaultModel: MODEL }).systemOne({
        state: { word: "yes" },
        questions: { q: noul("Is `word` yes?") },
      }),
    );

  const scenarios: Scenario[] = [];
  for (const f of files) {
    try {
      scenarios.push(...parseFeature(readFileSync(f, "utf8"), f));
      line(true, `${f} parses`);
    } catch (err) {
      line(false, `${f}: ${(err as Error).message}`);
    }
  }
  for (const url of new Set(scenarios.map((s) => s.url).filter((u) => u !== undefined))) {
    await attempt(`opens ${url}`, async () => (await Browser.open(toUrl(url))).close());
  }
  return failed ? 2 : 0;
}
