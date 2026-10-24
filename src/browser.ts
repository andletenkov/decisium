// Browser runtime: the only module that knows about Playwright. Swap for CDP behind the same surface.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser as PwBrowser, type BrowserContext, type BrowserContextOptions, type Dialog as PwDialog, type Page } from "playwright";
import { recordNetwork, replayNetwork, type NetworkReplay } from "./network.ts";
import { parseSnapshot, renderSnapshot, withDialog, withClipboard, withDownload, withPage, type AriaNode, type Dialog, type Download, type Observation, type Verb } from "./observation.ts";

export interface Action {
  verb: Verb | "SCROLL" | "SCROLL_UP" | "WAIT" | "ENTER" | "PRESS" | "ACCEPT" | "DISMISS" // ACCEPT/DISMISS: the open browser dialog
    | "GOTO" | "BACK" | "FORWARD" | "RELOAD" | "CLOSE_TAB" | "SWITCH_TAB" // task 0041
    | "HOVER" // task 0042
    | "UPLOAD" // task 0044: click `ref`, give the file chooser the file `value`
    | "DBLCLICK" | "RIGHTCLICK" | "DRAG" // task 0045
    | "PASTE"; // task 0062: click `ref`, press Ctrl/Cmd+V
  ref?: string; // element actions only
  to?: string; // DRAG: ref of the element to drop onto
  value?: string; // UPLOAD: a path relative to the feature file; PRESS: the key, as Playwright names it; ACCEPT: a prompt's text; GOTO: URL or path, resolved against the start URL
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

/**
 * Adds `[description="..."]` to the lines of elements whose `title` differs from their name: the snapshot drops `title`
 * (task 0042). Matched by name, like markCollapsed.
 */
const markTitles = (snapshot: string, titles: ReadonlyMap<string, string>) =>
  titles.size ? snapshot.split("\n").map(line => {
    const m = /^\s*- \w+ "((?:[^"\\]|\\.)*)"[^\n]*?( \[ref=\w+\])/.exec(line);
    const title = m && titles.get(m[1].replace(/\\(.)/g, "$1"));
    return title ? line.replace(m![2], ` [description="${title}"]${m![2]}`) : line;
  }).join("\n") : snapshot;

/** Adds `[flag]` after the ref of each element in `refs`: parseSnapshot offers it as a target (tasks 0045, 0061). */
const markRefs = (snapshot: string, refs: ReadonlySet<string>, flag: string) =>
  refs.size ? snapshot.replace(/\[ref=(\w+)\]/g, (m, ref) => refs.has(ref) ? `${m} [${flag}]` : m) : snapshot;

/** Facts the snapshot lacks, per element (tasks 0045, 0061, 0064); each stays separate for track B. */
type Fact = "draggable" | "scrollable" | "pointer" | "tabindex";

/**
 * `factsIn`: indexes of `els` with a fact, and which. Runs in the page. Native controls are skipped for the target facts: their
 * role already makes them targets. `pointer`: own cursor, not inherited from the parent (OrangeHRM's select wrapper,
 * not the text inside it).
 */
const factsIn = (els: Element[]) => els.flatMap((e, i) => {
  const out: string[] = [];
  const style = getComputedStyle(e);
  if (e.getAttribute("draggable") === "true") out.push("draggable");
  if (/auto|scroll/.test(style.overflowY) && e.scrollHeight > e.clientHeight && e !== document.scrollingElement) out.push("scrollable");
  if (!e.matches("a[href], button, input, select, textarea, summary, label, option, iframe") && e.checkVisibility()) {
    if (style.cursor === "pointer" && (!e.parentElement || getComputedStyle(e.parentElement).cursor !== "pointer")) out.push("pointer");
    if (e.hasAttribute("tabindex") && (e as HTMLElement).tabIndex >= 0) out.push("tabindex");
  }
  return out.length ? [[i, out] as [number, string[]]] : [];
});

/** Hover moves the mouse only; an element that never stops moving (a tooltip shifting the layout) fails fast (task 0042). */
const HOVER_TIMEOUT_MS = 2000;

export class Browser {
  private browser: PwBrowser;
  /** Public for client step definitions (`this.context` on the World, task 0048). */
  readonly context: BrowserContext;
  /** The tab Steps act on. A tab the page opens (a popup, a target=_blank link) becomes it at once (task 0041). Public as `this.page`. */
  page: Page;
  /** `@replay-network` requests missing from the recording, until the Step that made them fails on them (task 0048). */
  readonly networkMisses: string[] = [];
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
  /** Task 0044: UPLOAD paths resolve against `files` (the feature's folder); downloads are saved to `downloads`. */
  private files = ".";
  private downloads?: string;
  private download?: Download; // the last finished download, readable for checks
  /** Task 0062: a headed browser may share the OS clipboard; only text copied since the open is shown. */
  private clipboardAtOpen?: string;
  private async readClipboard() { return this.page.evaluate(() => navigator.clipboard?.readText()).catch(() => undefined); } // undefined: insecure origin (data:)
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
    context.on("page", p => { this.page = p; this.watchDownloads(p); });
    this.watchDownloads(page);
    this.rearm();
    context.on("dialog", d => {
      this.open = d;
      this.dialog = { type: d.type() as Dialog["type"], message: this.mask(d.message()) || (d.type() === "beforeunload" ? LEAVE : ""), state: "open" };
      this.signal();
    });
  }

  /** Saves each download; counted in flight until saved, so the action that started it settles after it. */
  private watchDownloads(page: Page) {
    page.on("download", d => {
      if (!this.downloads) return;
      this.inflight++;
      const path = join(this.downloads, d.suggestedFilename());
      d.saveAs(path).then(() => {
        const bytes = readFileSync(path);
        // Text: no NUL byte. Binary contents are not compared.
        this.download = { name: d.suggestedFilename(), size: bytes.length, text: bytes.includes(0) ? undefined : this.mask(bytes.toString("utf8")) };
      }).catch(() => {}).finally(() => this.inflight--);
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

  /**
   * `trace`: record a Playwright trace, saved by close(tracePath). `secrets`: placeholder token -> value. `files`: the
   * folder UPLOAD paths are relative to; `downloads`: where downloads are saved (none: not saved, not readable).
   * `context`: options that must exist before the page opens (tags, task 0048); `network`: `@replay-network`.
   */
  static async open(url: string, headed = false, trace = false, secrets: Record<string, string> = {}, files = ".", downloads?: string,
    context: BrowserContextOptions = {}, network?: NetworkReplay): Promise<Browser> {
    const browser = await chromium.launch({ headless: !headed, slowMo: Number(process.env.SLOWMO ?? 0) }) // SLOWMO=ms: pause per browser action for demos;
    // Task 0062: copy buttons and paste need the clipboard; granted for every origin (file:// and localhost measured).
    const permissions = [...context.permissions ?? [], "clipboard-read", "clipboard-write"];
    const page = await (await browser.newContext({ ...context, permissions })).newPage();
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
    b.files = files;
    b.downloads = downloads;
    b.clipboardAtOpen = await b.readClipboard();
    try {
      if (network?.mode === "record") await recordNetwork(b.context, network);
      if (network?.mode === "replay") await replayNetwork(b.context, network, r => b.networkMisses.push(r));
    } catch (err) {
      await browser.close();
      throw err;
    }
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
    const clip = page ? await this.readClipboard() : undefined;
    const copied = clip && clip !== this.clipboardAtOpen ? this.mask(clip) : undefined;
    return (this.last = withDialog(withClipboard(withDownload(this.under ?? withPage(parseSnapshot(""), this.page.url(), ""), this.download), copied), this.dialog));
  }

  private async read(): Promise<Observation> {
    const found = await this.facts();
    const refs = (fact: Fact) => new Set([...found].filter(([, f]) => f.includes(fact)).map(([ref]) => ref));
    const targets = new Set([...refs("pointer"), ...refs("tabindex")]);
    const snapshot = renderSnapshot(await this.page.ariaSnapshotJSON({ mode: "ai" }) as AriaNode[]);
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
    const marked = this.mask(markRefs(markRefs(markTitles(markCollapsed(markCurrent(snapshot, await this.currentLinks(snapshot)), await this.collapsed()), await this.titles()),
      refs("draggable"), "draggable"), refs("scrollable"), "scrollable"));
    const title = this.mask(await this.page.title().catch(() => "")); // mid-navigation
    const tabs = this.context.pages();
    const where = tabs.length > 1 ? `${tabs.length} open, this is tab ${tabs.indexOf(this.page) + 1}` : undefined;
    return withPage(parseSnapshot(marked, secret, editable, targets), this.mask(this.page.url()), title, where);
  }

  /** Collapsed controls (`aria-expanded=false` + `aria-controls`, closed `<details>`) by name -> hidden entries they hold. */
  private async collapsed(): Promise<Map<string, string[]>> {
    // Every frame (iframes are in the snapshot); shortcut: open shadow roots are not searched, walk them if a page needs it.
    const found = (await Promise.all(this.page.frames().map(f => f.evaluate(() => {
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
    }).catch(() => [] as (readonly [string, string[]])[])))).flat(); // mid-navigation: no hints this time
    // shortcut: matched by name, so two collapsed controls with the same name and different entries get the first
    // one's; resolve by ref (one locator call per candidate) if a page shows that.
    const out = new Map<string, string[]>();
    for (const [n, entries] of found) if (!out.has(n)) out.set(n, entries);
    return out;
  }

  /** `title` attributes of visible elements by name, where the title says more than the name. */
  private async titles(): Promise<Map<string, string>> {
    const found = (await Promise.all(this.page.frames().map(f => f.locator("[title]").evaluateAll(els => els.filter(e => e.checkVisibility()).map(e => {
      const name = (e.getAttribute("aria-label") || (e as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      const title = e.getAttribute("title")!.replace(/\s+/g, " ").trim();
      return [name, (title.length > 60 ? title.slice(0, 60) + "…" : title).replace(/["\]]/g, "'")] as const;
    }).filter(([n, t]) => n && t && n !== t)).catch(() => [] as (readonly [string, string])[])))).flat(); // mid-navigation
    // shortcut: matched by name, so two same-named elements with different titles get the first one's.
    const out = new Map<string, string>();
    for (const [n, t] of found) if (!out.has(n)) out.set(n, t);
    return out;
  }

  /**
   * Facts by ref, for elements `factsIn` picks in any frame (open shadow roots included): one DOM read per frame, then
   * one element snapshot per match. Run before the page snapshot: an element snapshot invalidates older refs, and the
   * page snapshot after it reuses the refs it gave. Reading per ref instead took ~2 s per Observation on Wikipedia.
   */
  private async facts(): Promise<Map<string, Fact[]>> {
    const out = new Map<string, Fact[]>();
    for (const f of this.page.frames()) {
      const all = f.locator("body *");
      const hits = await all.evaluateAll(factsIn).catch(() => [] as [number, string[]][]);
      for (const [i, found] of hits) {
        const line = await all.nth(i).ariaSnapshot({ mode: "ai", depth: 0, timeout: 1000 }).catch(() => "");
        const ref = /\[ref=(\w+)\]/.exec(line)?.[1];
        if (ref) out.set(ref, found as Fact[]);
      }
    }
    return out;
  }

  /**
   * Refs of links marked aria-current (the current page or tab in a navigation). The hrefs of aria-current links pick
   * the candidates; each candidate is then read by ref, since links that share an href ("#") can differ.
   */
  private async currentLinks(snapshot: string): Promise<Set<string>> {
    const hrefs = (await Promise.all(this.page.frames().map(f => f.locator('a[aria-current]:not([aria-current="false"])')
      .evaluateAll(els => els.map(e => e.getAttribute("href") ?? ""))
      .catch(() => [] as string[])))).flat();
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

  private async perform({ verb, ref, to, value = "" }: Action): Promise<void> {
    const opts = { timeout: 5000 };
    if ((verb === "SCROLL" || verb === "SCROLL_UP") && ref) await this.page.locator(`aria-ref=${ref}`).hover(opts); // the wheel scrolls what is under the mouse
    if (verb === "SCROLL" || verb === "SCROLL_UP") await this.page.mouse.wheel(0, verb === "SCROLL" ? 600 : -600);
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
      else if (verb === "HOVER") await target.hover({ timeout: HOVER_TIMEOUT_MS });
      else if (verb === "DBLCLICK") await target.dblclick(opts);
      else if (verb === "RIGHTCLICK") await target.click({ ...opts, button: "right" });
      else if (verb === "DRAG") await target.dragTo(this.page.locator(`aria-ref=${to}`), opts);
      else if (verb === "PASTE") { await target.click(opts); await this.page.keyboard.press("ControlOrMeta+V"); }
      else if (verb === "UPLOAD") {
        const path = resolve(this.files, value);
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`no file "${value}" next to the feature file`);
        // File inputs are often hidden behind a button: the click opens the chooser, which gets the file.
        const [chooser] = await Promise.all([this.page.waitForEvent("filechooser", opts), target.click(opts)]);
        await chooser.setFiles(path, opts);
      }
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
          const field = await (await now()).elementHandle();
          if (field) {
            try {
              const left = await this.unblocked(field.evaluate(el => { (el as HTMLElement).blur(); return true; }));
              if (!left || this.open) return; // A blur dialog is answered in a later Turn; never refocus behind it.
              await field.evaluate(el => {
                // Keep TYPE → Enter working unless on-leave validation took focus or removed the field.
                if (document.activeElement === document.body && el.isConnected && el.checkVisibility()
                  && !el.matches(":disabled")) (el as HTMLElement).focus();
              });
            } finally { await field.dispose(); }
          }
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
    if (tracePath && !this.typedSecret) await this.context.tracing.stop({ path: tracePath }).catch(() => undefined);
    await this.context.close(); // writes a @replay-network recording
    await this.browser.close();
  }
}
