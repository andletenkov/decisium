// Browser runtime: the only module that knows about Playwright. Swap for CDP behind the same surface.
import { chromium, type Browser as PwBrowser, type Page } from "playwright";
import { parseSnapshot, type Observation, type Verb } from "./observation.ts";

export interface Action {
  verb: Verb | "SCROLL" | "WAIT";
  ref?: string; // element actions only
  value?: string;
}

const QUIET_MS = 100; // no requests in flight and no DOM mutations for this long = settled
// shortcut: long-lived requests (SSE, long polling), intervals and endless animations never go quiet, so every
// action waits the full cap and failing checks wait WAIT_CAP_MS; ignore such work by URL/type when a real app needs it.
// Not tracked: Web Workers, and timers inside cross-origin iframes.
const SETTLE_CAP_MS = 5000; // pages that never go quiet continue after this
const WAIT_CAP_MS = 5000; // WAIT and assertion retries give up after this

export class Browser {
  private browser: PwBrowser;
  private page: Page;
  private inflight = 0;
  private constructor(browser: PwBrowser, page: Page) {
    this.browser = browser;
    this.page = page;
    page.on("request", () => this.inflight++);
    page.on("requestfinished", () => this.inflight--);
    page.on("requestfailed", () => this.inflight--);
  }

  static async open(url: string, headed = false): Promise<Browser> {
    const browser = await chromium.launch({ headless: !headed });
    const page = await browser.newPage();
    // In every document: the time of the last DOM mutation, and a count of work that can still change the page
    // on its own (timers, intervals, animation frames, open sockets). Requests are counted from Node.
    await page.addInitScript(() => {
      const w = window as unknown as Window & { __lastMutation: number; __pending: () => number };
      w.__lastMutation = performance.now();
      new MutationObserver(() => { w.__lastMutation = performance.now(); })
        .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

      const timers = new Set<unknown>(), frames = new Set<number>();
      let sockets = 0;
      const { setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci, requestAnimationFrame: raf, cancelAnimationFrame: caf } = w;
      w.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        const id = st((...a: unknown[]) => { timers.delete(id); if (typeof fn === "function") fn(...a); }, ms, ...args);
        timers.add(id);
        return id;
      }) as typeof setTimeout;
      w.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        const id = si(fn, ms, ...args);
        timers.add(id);
        return id;
      }) as typeof setInterval;
      // Browsers let either clear function cancel either kind of timer.
      w.clearTimeout = w.clearInterval = (id?: number) => { timers.delete(id); ct(id); ci(id); };
      w.requestAnimationFrame = cb => { const id = raf(t => { frames.delete(id); cb(t); }); frames.add(id); return id; };
      w.cancelAnimationFrame = id => { frames.delete(id); caf(id); };
      // any: constructor args are forwarded untouched
      type Socket = new (...a: any[]) => EventTarget & { readyState: number; close(): void };
      const g = w as unknown as { WebSocket: Socket; EventSource: Socket };
      const Ws = g.WebSocket, Es = g.EventSource;
      g.WebSocket = class extends Ws {
        constructor(...a: unknown[]) { super(...a); sockets++; this.addEventListener("close", () => sockets--); }
      };
      g.EventSource = class extends Es {
        constructor(...a: unknown[]) { super(...a); sockets++; }
        close() { if (this.readyState !== 2 /* CLOSED */) sockets--; super.close(); }
      };
      w.__pending = () => timers.size + frames.size + sockets;
    });
    const b = new Browser(browser, page);
    await page.goto(url);
    await b.settle();
    return b;
  }

  /** Waits until no request is in flight and the DOM has not changed for QUIET_MS (capped). */
  private async settle(): Promise<void> {
    const start = Date.now();
    while (Date.now() < start + SETTLE_CAP_MS) {
      const sinceMutation = await this.page
        .evaluate(() => performance.now() - (window as unknown as { __lastMutation: number }).__lastMutation)
        .catch(() => 0); // mid-navigation: not settled yet
      // The quiet window starts no earlier than the action: effects may begin a task later (e.g. hashchange).
      const quiet = Math.min(sinceMutation, Date.now() - start);
      if (this.inflight === 0 && quiet >= QUIET_MS) return;
      await this.page.waitForTimeout(25);
    }
  }

  async observe(): Promise<Observation> {
    const snapshot = await this.page.ariaSnapshot({ mode: "ai" });
    // Password inputs look like plain textboxes in the snapshot; ask the DOM which ones are secret.
    const secret = new Set<string>();
    for (const [, ref] of snapshot.matchAll(/- textbox\b[^\n]*\[ref=(\w+)\]/g)) {
      const isPassword = await this.page.locator(`aria-ref=${ref}`)
        .evaluate(el => (el as HTMLInputElement).type === "password", undefined, { timeout: 1000 })
        .catch(() => false);
      if (isPassword) secret.add(ref);
    }
    return parseSnapshot(snapshot, secret);
  }

  /** Executes one action and checks its effect where the effect is deterministic (TYPE/SELECT). */
  async execute({ verb, ref, value = "" }: Action): Promise<void> {
    const opts = { timeout: 5000 };
    if (verb === "SCROLL") await this.page.mouse.wheel(0, 600);
    else if (verb === "WAIT") await this.waitForChange((await this.observe()).text, WAIT_CAP_MS);
    else {
      const target = this.page.locator(`aria-ref=${ref}`);
      if (verb === "CLICK") await target.click(opts);
      else if (verb === "TYPE") {
        await target.fill(value, opts);
        // Message omits the values: the field may be a password.
        if ((await target.inputValue(opts)) !== value) throw new Error("field does not hold the typed value after TYPE");
      } else {
        await target.selectOption({ label: value }, opts);
        const shown = await target.evaluate(el => (el as HTMLSelectElement).selectedOptions[0]?.label, undefined, opts);
        if (shown !== value) throw new Error(`select shows "${shown}" after SELECT "${value}"`);
      }
    }
    await this.settle();
  }

  /**
   * Waits until the Observation differs from `since` (true), the timeout passes, or the page cannot change on its
   * own any more (false): no request, timer, animation frame or socket pending on two polls in a row.
   */
  async waitForChange(since: string, timeoutMs = WAIT_CAP_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let idleBefore = false;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(100);
      if ((await this.observe()).text !== since) {
        await this.settle();
        return true;
      }
      // Two idle polls 100 ms apart: promise chains (e.g. reading a fetch body) finish in between.
      const idle = await this.idle();
      if (idle && idleBefore) return false;
      idleBefore = idle;
    }
    return false;
  }

  /** True when nothing pending in the page can change it without user input. */
  private async idle(): Promise<boolean> {
    if (this.inflight > 0) return false;
    const pending = await this.page
      .evaluate(() => (window as unknown as { __pending?: () => number }).__pending?.() ?? 1)
      .catch(() => 1); // mid-navigation: not idle
    return pending === 0;
  }

  close(): Promise<void> {
    return this.browser.close();
  }
}
