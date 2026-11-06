// `@save:storage` (issue 11): a state's cookies and localStorage, saved by the first scenario in a run that reaches it
// and loaded into later ones. Run-scoped: a temp directory outside the workspace, removed when the run ends. Files hold
// live session tokens: directory 0700, files 0600, a `.gitignore` of `*`, never printed.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext } from "playwright";
import type { StateDef } from "./states.ts";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/** Only what belongs to `url`'s origin: staging and prod never share a session. */
export function forOrigin(state: StorageState, url: string): StorageState {
  const { hostname, origin } = new URL(url);
  const host = hostname.toLowerCase();
  return {
    cookies: state.cookies.filter((c) => {
      const d = c.domain.replace(/^\./, "").toLowerCase();
      return host === d || host.endsWith(`.${d}`);
    }),
    origins: state.origins.filter((o) => o.origin === origin),
  };
}

export interface Plan {
  load?: number; // index in the chain whose saved storage the browser starts with
  mine: string[]; // saved states this scenario replays and saves (it holds their locks)
}

export class SavedStorage {
  readonly dir: string;
  held = new Set<string>();
  constructor(runPath: string, base = tmpdir()) {
    this.dir = join(base, `decisium-storage-${hash(resolve(runPath))}`);
  }
  #path(name: string, ext: string) {
    return join(this.dir, `${hash(name)}.${ext}`);
  }
  #ensure() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const ignore = join(this.dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  }
  has(name: string) {
    return existsSync(this.#path(name, "json"));
  }
  read(name: string): StorageState {
    return JSON.parse(readFileSync(this.#path(name, "json"), "utf8"));
  }
  /** Writes atomically (per-process tmp name, then rename), 0600, and releases the lock. */
  write(name: string, state: StorageState) {
    this.#ensure();
    const tmp = this.#path(name, `${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.#path(name, "json"));
    this.unlock(name);
  }
  /** Drops a saved state that failed its check after loading, so the next consumer replays it. */
  forget(name: string) {
    rmSync(this.#path(name, "json"), { force: true });
  }
  tryLock(name: string): boolean {
    this.#ensure();
    try {
      closeSync(openSync(this.#path(name, "lock"), "wx", 0o600));
    } catch {
      return false;
    }
    this.held.add(name);
    return true;
  }
  locked(name: string) {
    return existsSync(this.#path(name, "lock"));
  }
  unlock(name: string) {
    if (this.held.delete(name)) rmSync(this.#path(name, "lock"), { force: true });
  }
  /** Releases every lock this process holds (a scenario that failed before saving). */
  release() {
    for (const n of [...this.held]) this.unlock(n);
  }
  remove() {
    rmSync(this.dir, { recursive: true, force: true });
  }

  /**
   * Which saved storage to start from and which saved states to produce. Waits while another worker is producing one
   * this chain needs (it is created once per run). `timeout`: how long to wait for it, in ms.
   */
  async plan(chain: StateDef[], timeout = 10 * 60_000, poll = 200): Promise<Plan> {
    const until = Date.now() + timeout;
    for (;;) {
      const saved = chain.flatMap((d, i) => (d.save && this.has(d.name) ? [i] : []));
      const load = saved.at(-1);
      const missing = chain.filter((d, i) => d.save && i > (load ?? -1));
      if (!missing.some((d) => this.locked(d.name))) {
        const mine: string[] = [];
        for (const d of missing) if (this.tryLock(d.name)) mine.push(d.name);
        if (mine.length === missing.length) return { load, mine };
        for (const n of mine) this.unlock(n); // another worker took one in between: wait for it
      }
      if (Date.now() > until) throw new Error("timed out waiting for another worker to save a state's storage");
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}
