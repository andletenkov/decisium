// Network record/replay for `@replay-network:<glob>` (task 0048). Recording: Playwright's routeFromHAR writes only the
// matching requests to a HAR (bodies in files beside it). Replay: our own route handler, not routeFromHAR, because that
// matches request bodies exactly and misses every POST with a timestamp or id in it. A request is matched by method +
// URL + occurrence (the n-th call to that URL), body ignored; one not in the recording is aborted and reported, never
// sent live.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContext } from "playwright";

export interface NetworkReplay { glob: string; har: string; mode: "record" | "replay" }

interface HarEntry {
  request: { method: string; url: string };
  response: { status: number; headers: { name: string; value: string }[]; content: { text?: string; encoding?: string; _file?: string } };
}

export async function recordNetwork(context: BrowserContext, { glob, har }: NetworkReplay): Promise<void> {
  mkdirSync(dirname(har), { recursive: true });
  await context.routeFromHAR(har, { url: glob, update: true, updateContent: "attach", updateMode: "minimal" });
}

/** `missed` gets "METHOD url" for each matching request the HAR does not have. */
export async function replayNetwork(context: BrowserContext, { glob, har }: NetworkReplay, missed: (request: string) => void): Promise<void> {
  if (!existsSync(har)) throw new Error(`No network recording ${har} for @replay-network:${glob}; record it with --record all.`);
  const entries: HarEntry[] = JSON.parse(readFileSync(har, "utf8")).log.entries;
  const served = new Map<string, number>(); // "METHOD url" -> times served
  await context.route(glob, route => {
    const req = route.request();
    const key = `${req.method()} ${req.url()}`;
    const n = served.get(key) ?? 0;
    served.set(key, n + 1);
    const entry = entries.filter(e => `${e.request.method} ${e.request.url}` === key)[n];
    if (!entry) { missed(n ? `${key} (call ${n + 1})` : key); return route.abort(); }
    const { status, headers, content } = entry.response;
    const body = content._file ? readFileSync(join(dirname(har), content._file))
      : Buffer.from(content.text ?? "", content.encoding === "base64" ? "base64" : "utf8");
    // content-length/encoding describe the recorded transfer, not the decoded body served here.
    const kept = headers.filter(h => !/^(content-length|content-encoding|transfer-encoding)$/i.test(h.name));
    return route.fulfill({ status, headers: Object.fromEntries(kept.map(h => [h.name, h.value])), body });
  });
}
