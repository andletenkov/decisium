// Browser runtime: the only module that knows about Playwright. Swap for CDP behind the same surface.
import { chromium, type Browser as PwBrowser, type BrowserContext, type Dialog as PwDialog, type Page } from "playwright";
import { parseSnapshot, withDialog, withPage, type Dialog, type Observation, type Verb } from "./observation.ts";

export interface Action {
  verb: Verb | "SCROLL" | "WAIT" | "ENTER" | "PRESS" | "ACCEPT" | "DISMISS" // ACCEPT/DISMISS: the open browser dialog
    | "GOTO" | "BACK" | "FORWARD" | "RELOAD" | "CLOSE_TAB" | "SWITCH_TAB"; // task 0041
  ref?: string; // element actions only
  value?: string; // PRESS: the key, as Playwright names it; ACCEPT: a prompt's text; GOTO: URL or path, resolved against the start URL
}

/** Chrome shows this for beforeunload; the page cannot set its own text. */
const LEAVE = "Leave site? Changes you made may not be saved.";

const QUIET_MS = 100; // no requests in flight and no DOM mutations for this long = settled
// shortcut: long-lived requests (SSE, long polling), endless chains of short timers and endless animations never go
// quiet, so actions wait up to the full cap (github.com home: open ~5.5 s, some clicks 5 s) and failing checks wait
// WAIT_CAP_MS; ignore such work by URL/type when the waiting costs too much.
// Not tracked: Web Workers, and timers inside cross-origin iframes.
const SETTLE_CAP_MS = 5000; // pages that never go quiet continue after this
const WAIT_CAP_MS = 5000; // WAIT and assertion retries give up after this

/** Snapshot links with their `/url` line: [ref, url]. */
const links = (snapshot: string): [string, string][] =>
  [...snapshot.matchAll(/- link\b[^\n]*\[ref=(\w+)\][^\n]*\n\s*- \/url: "?(.*?)"?$/gm)].map(m => [m[1], m[2]]);

/** Adds `[current]` to the given refs' lines (Playwright's snapshot drops aria-current). */
const markCurrent = (snapshot: string, refs: ReadonlySet<string>) =>
  refs.size ? snapshot.replace(/ \[ref=(\w+)\]/g, (m, ref) => (refs.has(ref) ? ` [current]${m}` : m)) : snapshot;

/**
 * Adds `[collapsed; hidden entries: "A", "B"]` to collapsed controls' lines: the snapshot drops hidden content, so a
 * Step naming an entry inside a collapsed ToC section or accordion had nothing to pick (task 0024). Links only: hidden
 * headings and buttons were mostly error templates of menus ("Uh oh!", "Please reload this page" on GitHub). Only `ui` gets it;
 * names, values and pageText do not, so a check cannot pass on text that is not shown.
 */
const markCollapsed = (snapshot: string, hidden: ReadonlyMap<string, string[]>) =>
  hidden.size ? snapshot.split("\n").map(line => {
    const m = /^\s*- \w+ "((?:[^"\\]|\\.)*)"[^\n]*?( \[ref=\w+\])/.exec(line);
    const entries = m && !/\[expanded\]/.test(line) ? hidden.get(m[1].replace(/\\(.)/g, "$1")) : undefined;
    return entries ? line.replace(m![2], ` [collapsed; hidden entries: ${entries.map(e => `"${e}"`).join(", ")}]${m![2]}`) : line;
  }).join("\n") : snapshot;

export class Browser {
  private browser: PwBrowser;
  private context: BrowserContext;
  /** The tab Steps act on. A tab the page opens (a popup, a target=_blank link) becomes it at once (task 0041). */
  private page: Page;
  private start: string; // GOTO paths resolve against it
  private inflight = 0;
  private last?: Observation; // refs are valid for the latest Observation only
  /**
   * Browser dialogs (task 0040). While one is open the page is blocked (snapshots, evaluate, screenshots and clicks
   * hang), so the Observation is the page as it was under it; `opened` resolves when one opens.
   */
  private open?: PwDialog;
  private dialog?: Dialog; // open, or the last one shown until the next action Step
  private under?: Observation; // the page under the dialog
  private opened!: Promise<undefined>;
  private signal!: () => void;
  readonly consoleErrors: string[] = [];
  /** Secret placeholders (`$NAME` -> value): typed for the token, masked back to it in every Observation (task 0030). */
  private secrets: Record<string, string> = {};
  /** A secret was typed: the Playwright trace stores typed text unmasked, so close() keeps none. */
  typedSecret = false;
  private mask(s: string) { return Object.entries(this.secrets).reduce((t, [token, value]) => t.replaceAll(value, token), s); }

  private constructor(browser: PwBrowser, page: Page, start: string) {
    this.browser = browser;
    this.page = page;
    this.start = start;
    // On the context, not the page: they must follow into tabs the page opens.
    const context = this.context = page.context();
    context.on("console", m => { if (m.type() === "error") this.consoleErrors.push(m.text()); });
    context.on("weberror", e => this.consoleErrors.push(`uncaught: ${e.error().message}`));
    context.on("request", () => this.inflight++);
    context.on("requestfinished", () => this.inflight--);
    context.on("requestfailed", () => this.inflight--);
    context.on("page", p => { this.page = p; });
    this.rearm();
    context.on("dialog", d => {
      this.open = d;
      this.dialog = { type: d.type() as Dialog["type"], message: this.mask(d.message()) || (d.type() === "beforeunload" ? LEAVE : ""), state: "open" };
      this.signal();
    });
  }

  private rearm() { this.opened = new Promise(r => { this.signal = () => r(undefined); }); }

  /** `p`, or undefined once a dialog is open: the page is blocked until it is answered. */
  private unblocked<T>(p: Promise<T>): Promise<T | undefined> {
    p.catch(() => {}); // finishes once the dialog is answered; nobody waits for it then
    return Promise.race([p, this.opened]);
  }

  /** Owns per-Action-step cleanup, including thrown errors. `execute` keeps cleanup actions in the runtime's trace. */
  async actionStep<T>(run: () => Promise<T>, log = console.log, execute = (a: Action) => this.execute(a)): Promise<T> {
    if (!this.open) this.dialog = undefined;
    try {
      return await run();
    } finally {
      while (this.open) {
        const d = this.dialog!;
        await execute({ verb: "DISMISS" });
        log(`  Dialog: ${d.type} "${d.message}" was still open when the Step ended: dismissed`);
      }
    }
  }

  /** `trace`: record a Playwright trace, saved by close(tracePath). `secrets`: placeholder token -> value. */
  static async open(url: string, headed = false, trace = false, secrets: Record<string, string> = {}): Promise<Browser> {
    const browser = await chromium.launch({ headless: !headed, slowMo: Number(process.env.SLOWMO ?? 0) }) // SLOWMO=ms: pause per browser action for demos;
    const page = await browser.newPage();
    if (trace) await page.context().tracing.start({ screenshots: true, snapshots: true });
    // In every document, new tabs included: the time of the last DOM mutation, and a count of work that can still change
    // the page on its own (timers, intervals, animation frames, open sockets). Requests are counted from Node.
    await page.context().addInitScript(() => {
      const w = window as unknown as Window & { __lastMutation: number; __pending: () => number; __soon: () => number };
      w.__lastMutation = performance.now();
      new MutationObserver(() => { w.__lastMutation = performance.now(); })
        .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

      // Pending work, by id -> due time (ms since page start; Infinity for intervals, which never finish).
      const timers = new Map<unknown, number>(), frames = new Set<number>(), idles = new Set<number>();
      let sockets = 0;
      const { setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci, requestAnimationFrame: raf, cancelAnimationFrame: caf,
        requestIdleCallback: ric, cancelIdleCallback: cic } = w;
      w.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        const id = st((...a: unknown[]) => { timers.delete(id); if (typeof fn === "function") fn(...a); }, ms, ...args);
        timers.set(id, performance.now() + (ms ?? 0));
        return id;
      }) as typeof setTimeout;
      w.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        const id = si(fn, ms, ...args);
        timers.set(id, Infinity);
        return id;
      }) as typeof setInterval;
      // Browsers let either clear function cancel either kind of timer.
      w.clearTimeout = w.clearInterval = (id?: number) => { timers.delete(id); ct(id); ci(id); };
      w.requestAnimationFrame = cb => { const id = raf(t => { frames.delete(id); cb(t); }); frames.add(id); return id; };
      w.cancelAnimationFrame = id => { frames.delete(id); caf(id); };
      w.requestIdleCallback = (cb, opts) => { const id = ric(d => { idles.delete(id); cb(d); }, opts); idles.add(id); return id; };
      w.cancelIdleCallback = id => { idles.delete(id); cic(id); };
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
      w.__pending = () => timers.size + frames.size + idles.size + sockets;
      // Work about to change the page: timeouts due within 1 s and idle callbacks. Not intervals, long timers (polling,
      // session refresh) or animation frames (endless animations), which would make every action wait the full cap.
      w.__soon = () => idles.size + [...timers.values()].filter(due => due - performance.now() <= 1000).length;
    });
    const b = new Browser(browser, page, url);
    b.secrets = secrets;
    try {
      const loading = page.goto(url);
      while ((await b.unblocked(loading)) === undefined) await b.execute({ verb: "DISMISS" }); // no Step answers it
    } catch (err) {
      await browser.close();
      const why = (err as Error).message.split("\n")[0].replace(/^page\.goto:\s*/, "");
      throw new Error(`Cannot open ${url}: ${why}. Is the app running and the URL right?`);
    }
    await b.settle();
    while (b.open) await b.execute({ verb: "DISMISS" }); // opened by a timer after the load: no Step answers it either
    return b;
  }

  /**
   * Waits until no request is in flight, no work is due soon (see __soon: lazily loaded code runs idle callbacks and
   * short timers after its scripts arrive, before it renders) and the DOM has not changed for QUIET_MS (capped).
   */
  private async settle(): Promise<void> {
    const start = Date.now();
    while (Date.now() < start + SETTLE_CAP_MS) {
      if (this.open) return; // nothing changes until it is answered
      const [sinceMutation, soon] = await this.unblocked(this.page
        .evaluate(() => {
          const w = window as unknown as { __lastMutation: number; __soon?: () => number };
          return [performance.now() - w.__lastMutation, w.__soon?.() ?? 0];
        })
        .catch(() => [0, 1])) ?? [0, 1]; // mid-navigation: not settled yet
      // The quiet window starts no earlier than the action: effects may begin a task later (e.g. hashchange).
      const quiet = Math.min(sinceMutation, Date.now() - start);
      if (this.inflight === 0 && soon === 0 && quiet >= QUIET_MS) return;
      await this.page.waitForTimeout(25);
    }
  }

  async observe(): Promise<Observation> {
    const page = this.open ? undefined : await this.unblocked(this.read());
    if (page) this.under = page;
    return (this.last = withDialog(this.under ?? withPage(parseSnapshot(""), this.page.url(), ""), this.dialog));
  }

  private async read(): Promise<Observation> {
    const snapshot = await this.page.ariaSnapshot({ mode: "ai" });
    // The snapshot cannot tell a password field from a textbox, or an editable combobox (search box with suggestions)
    // from a button-like one; ask the DOM.
    const secret = new Set<string>(), editable = new Set<string>();
    for (const [, role, ref] of snapshot.matchAll(/- (textbox|combobox)\b[^\n]*\[ref=(\w+)\]/g)) {
      const kind = await this.page.locator(`aria-ref=${ref}`)
        .evaluate(el => (el as HTMLInputElement).type === "password" ? "secret"
          : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable ? "editable" : "",
        undefined, { timeout: 1000 })
        .catch(() => "");
      if (kind === "secret") secret.add(ref);
      else if (kind === "editable" && role === "combobox") editable.add(ref);
    }
    // shortcut: masks the value as the snapshot spells it; a value with quotes or backslashes (escaped there) or shown
    // reformatted would slip through, and screenshots show a secret typed into a non-password field; mask those if needed.
    const marked = this.mask(markCollapsed(markCurrent(snapshot, await this.currentLinks(snapshot)), await this.collapsed()));
    const title = this.mask(await this.page.title().catch(() => "")); // mid-navigation
    const tabs = this.context.pages();
    const where = tabs.length > 1 ? `${tabs.length} open, this is tab ${tabs.indexOf(this.page) + 1}` : undefined;
    return withPage(parseSnapshot(marked, secret, editable), this.mask(this.page.url()), title, where);
  }

  /** Collapsed controls (`aria-expanded=false` + `aria-controls`, closed `<details>`) by name -> hidden entries they hold. */
  private async collapsed(): Promise<Map<string, string[]>> {
    const found = await this.page.evaluate(() => {
      // Accessible-name approximation: aria-label, else text without aria-hidden parts (Wikipedia's "1.1" numbers).
      const text = (n: Node): string => n.nodeType === Node.TEXT_NODE ? n.textContent ?? ""
        : (n as Element).getAttribute?.("aria-hidden") === "true" ? "" : [...n.childNodes].map(text).join(" ");
      const name = (e: Element) => (e.getAttribute("aria-label") || text(e)).replace(/\s+/g, " ").trim();
      const controls = [...document.querySelectorAll('[aria-expanded="false"][aria-controls], details:not([open]) > summary')];
      return controls.map(c => {
        const scope = c.tagName === "SUMMARY" ? [c.parentElement!]
          : c.getAttribute("aria-controls")!.split(/\s+/).map(id => document.getElementById(id)).filter(e => e !== null);
        const entries = [...new Set(scope.flatMap(s => [...s.querySelectorAll("a[href]")])
          .filter(e => !e.checkVisibility()).map(name).filter(Boolean))];
        return [name(c), entries.slice(0, 10).map(e => (e.length > 60 ? e.slice(0, 60) + "…" : e).replace(/["\]]/g, "'"))] as const;
      }).filter(([n, entries]) => n && entries.length);
    }).catch(() => [] as (readonly [string, string[]])[]); // mid-navigation: no hints this time
    // shortcut: matched by name, so two collapsed controls with the same name and different entries get the first
    // one's; resolve by ref (one locator call per candidate) if a page shows that.
    const out = new Map<string, string[]>();
    for (const [n, entries] of found) if (!out.has(n)) out.set(n, entries);
    return out;
  }

  /**
   * Refs of links marked aria-current (the current page or tab in a navigation). The hrefs of aria-current links pick
   * the candidates; each candidate is then read by ref, since links that share an href ("#") can differ.
   */
  private async currentLinks(snapshot: string): Promise<Set<string>> {
    const hrefs = await this.page.locator('a[aria-current]:not([aria-current="false"])')
      .evaluateAll(els => els.map(e => e.getAttribute("href") ?? ""))
      .catch(() => [] as string[]);
    const current = new Set<string>();
    for (const [ref, url] of links(snapshot)) {
      if (!hrefs.includes(url)) continue;
      const value = await this.page.locator(`aria-ref=${ref}`).getAttribute("aria-current", { timeout: 1000 }).catch(() => null);
      if (value !== null && value !== "false") current.add(ref);
    }
    return current;
  }

  /**
   * Executes one action and checks its effect where the effect is deterministic (TYPE/SELECT). An action that opens a
   * dialog returns once it is open (its effect check is skipped); ACCEPT/DISMISS answer it.
   */
  async execute(action: Action): Promise<void> {
    const { verb, value = "" } = action;
    if (verb === "ACCEPT" || verb === "DISMISS") {
      const d = this.open;
      if (!d) throw new Error("no browser dialog is open");
      this.open = undefined;
      this.dialog = { ...this.dialog!, state: verb === "ACCEPT" ? "accepted" : "dismissed" };
      this.rearm(); // before answering: the next dialog may open at once
      if (value in this.secrets) this.typedSecret = true;
      await (verb === "ACCEPT" ? d.accept(this.secrets[value] ?? value) : d.dismiss());
    } else await this.unblocked(this.perform(action));
    await this.settle();
  }

  private async perform({ verb, ref, value = "" }: Action): Promise<void> {
    const opts = { timeout: 5000 };
    if (verb === "SCROLL") await this.page.mouse.wheel(0, 600);
    else if (verb === "ENTER") await this.page.keyboard.press("Enter");
    else if (verb === "PRESS") await this.page.keyboard.press(value); // to whatever has focus
    else if (verb === "WAIT") await this.waitForChange((await this.observe()).text, WAIT_CAP_MS);
    else if (verb === "GOTO") await this.page.goto(new URL(value, this.start).href);
    else if (verb === "BACK") await this.page.goBack();
    else if (verb === "FORWARD") await this.page.goForward();
    else if (verb === "RELOAD") await this.page.reload();
    else if (verb === "CLOSE_TAB" || verb === "SWITCH_TAB") {
      const tabs = this.context.pages();
      if (tabs.length < 2) throw new Error("only one tab is open");
      const from = this.page;
      this.page = tabs[(tabs.indexOf(from) + tabs.length - 1) % tabs.length]; // the previous tab
      await this.page.bringToFront();
      if (verb === "CLOSE_TAB") await from.close();
    }
    else {
      const target = this.page.locator(`aria-ref=${ref}`);
      if (verb === "CLICK") await target.click(opts);
      else {
        // The app may replace the control while re-rendering (a sorted list redrawn on change): the effect is then
        // read from the control with the same role and name.
        const el = this.last?.elements.find(e => e.ref === ref);
        const now = async () => (await target.count()) || !el ? target
          : this.page.getByRole(el.role as Parameters<Page["getByRole"]>[0], { name: el.name, exact: true }).first();
        if (verb === "TYPE") {
          const typed = this.secrets[value] ?? value;
          if (value in this.secrets) this.typedSecret = true;
          await target.fill(typed, opts);
          // Message omits the values: the field may be a password.
          if ((await (await now()).inputValue(opts)) !== typed) throw new Error("field does not hold the typed value after TYPE");
        } else {
          await target.selectOption({ label: value }, opts);
          const shown = await (await now()).evaluate(el => (el as HTMLSelectElement).selectedOptions[0]?.label, undefined, opts);
          if (shown !== value) throw new Error(`select shows "${shown}" after SELECT "${value}"`);
        }
      }
    }
  }


  /**
   * Waits until the Observation differs from `since` (true), the timeout passes, or the page cannot change on its
   * own any more (false): no request, timer, animation frame or socket pending on two polls in a row.
   */
  async waitForChange(since: string, timeoutMs = WAIT_CAP_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let idleBefore = false;
    let seen: number | undefined; // __lastMutation at the last snapshot: no DOM mutation since means no new snapshot
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(100);
      const stamp = await this.unblocked(this.page.evaluate(() => (window as unknown as { __lastMutation?: number }).__lastMutation).catch(() => undefined));
      const moved = stamp === undefined || stamp !== seen;
      seen = stamp;
      if (moved && (await this.observe()).text !== since) {
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
    if (this.open) return true; // blocked until answered
    if (this.inflight > 0) return false;
    const pending = await this.unblocked(this.page
      .evaluate(() => (window as unknown as { __pending?: () => number }).__pending?.() ?? 1)
      .catch(() => 1)) ?? 1; // mid-navigation, or a dialog opened: not idle
    return pending === 0;
  }

  screenshot(path: string): Promise<unknown> {
    return this.unblocked(this.page.screenshot({ path }).catch(() => undefined)); // a missing screenshot must not fail the test
  }

  /** `tracePath`: where to save the Playwright trace started by open(..., trace); omitted, or a secret typed = discard it. */
  async close(tracePath?: string): Promise<void> {
    if (tracePath && !this.typedSecret) await this.page.context().tracing.stop({ path: tracePath }).catch(() => undefined);
    await this.browser.close();
  }
}
