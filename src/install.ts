// `decisium install`: the browser for this Decisium, from its own Playwright. `npx playwright install` may fetch another
// Playwright (a global decisium has none in the project), whose Chromium build Decisium would not find.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function install(flags: { withDeps?: boolean; dryRun?: boolean }): number {
  const cli = join(dirname(fileURLToPath(import.meta.resolve("playwright/package.json"))), "cli.js");
  const args = [cli, "install", ...(flags.withDeps ? ["--with-deps"] : []), ...(flags.dryRun ? ["--dry-run"] : [])];
  const { status, error } = spawnSync(process.execPath, [...args, "chromium"], { stdio: "inherit" });
  if (error) console.error(`Error: ${error.message}`);
  return status === 0 ? 0 : 2;
}
