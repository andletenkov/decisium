import { settings } from "./options.ts";
import type { Action } from "./browser.ts";
import { placeholder, readStep, withIntent, type StepArgument } from "./step.ts";
import {
  capabilities,
  gate,
  GATE_TARGET_MARGIN,
  confidence,
  DONE_AFTER_ACTION,
  DONE_THRESHOLD,
  grouped,
  TOGGLES,
  NotYet,
  named,
  fmt,
  PAGE,
  type Assessment,
  type Decider,
  type Intent,
  type Pick,
  type ScenarioLines,
  type TurnAnswer,
} from "./decision.ts";
import { verdict as checkVerdict, type Verdict } from "./check.ts";
import { changes } from "./change.ts";
import { MASK, type Dialog, type Element, type Observation } from "./observation.ts";

export type StepOutcome =
  | "DONE"
  | "BLOCKED"
  | "AMBIGUOUS"
  | "ELEMENT_NOT_FOUND"
  | "ACTION_FAILED"
  | "STEP_TIMEOUT" // Action steps
  | "PASSED"
  | "ASSERTION_FAILED"
  | "UNVERIFIABLE" // Assertion steps (AMBIGUOUS too)
  | "JUDGED_PASSED"
  | "JUDGED_FAILED" // opt-in fuzzy Assertion steps
  | "UI_CHANGED"
  | "PAGE_TOO_LARGE" // either kind: a replay-only Resolution broke, the page is over Jev's request limit
  | "APP_ERROR" // Action steps blocked while the page's requests failed: a server error (5xx),
  | "RATE_LIMITED" // too many requests (429),
  | "NETWORK_ERROR"; // or no response at all

export interface Runtime {
  observe(): Promise<Observation>;
  execute(action: Action): Promise<void>;
  /** Resolves true once the Observation differs from `since`, false on timeout. */
  waitForChange(since: string, timeoutMs?: number): Promise<boolean>;
  /** Runs one Action step with runtime-owned setup and cleanup, even if it throws. */
  actionStep<T>(run: () => Promise<T>, log: typeof console.log): Promise<T>;
  /** Requests that failed since the current page started loading (HTTP >= 400 or no response), oldest first. */
  failedRequests?(): FailedRequest[];
  /** True when the page changed since the latest Observation (task 0066); absent: assume it did not. */
  stale?(): Promise<boolean>;
}

export interface FailedRequest {
  /** e.g. `GET https://api.x/articles` */
  request: string;
  status?: number;
  /** No response: the network error, e.g. `net::ERR_CONNECTION_REFUSED`. */
  error?: string;
}
/** `GET url -> 500`; credentials in the query masked (reports and Jev see it), the URL capped. */
export const describeFailure = (f: FailedRequest) => {
  const masked = f.request.replace(/([?&][^=&]*(?:key|token|secret|sig|auth|password)[^=&]*=)[^&]*/gi, "$1***");
  return `${masked.length > 200 ? `${masked.slice(0, 199)}…` : masked} -> ${f.status ?? f.error}`;
};

export interface StepResult {
  outcome: StepOutcome;
  reason?: string;
  /** PASSED resting on a barely-confident Jev answer: which answers, for the warning (task 0027). */
  marginal?: string;
}

/** `ask` on `obs`, re-observing after each change while it throws NotYet. */
async function settled<T>(
  rt: Runtime,
  obs: Observation,
  ask: (obs: Observation) => Promise<T>,
): Promise<[Observation, T]> {
  const deadline = Date.now() + settings().checkTimeout;
  for (;;) {
    try {
      return [obs, await ask(obs)];
    } catch (err) {
      if (!(err instanceof NotYet)) throw err;
      const left = deadline - Date.now();
      if (left > 0 && (await rt.waitForChange(obs.text, left))) obs = await rt.observe();
      else if (err.giveUp) {
        err.giveUp();
        return [obs, await ask(obs)];
      } else throw err.final;
    }
  }
}

/** Jev torn between "nothing to do" and a toggle already in the wanted state (task 0043): both mean done. */
function alreadyToggled(pick: Pick, obs: Observation, goal: boolean | undefined): boolean {
  const done = (c: string) => c === "none" || obs.elements.some((e) => e.ref === c && toggled(e, goal));
  if (!Object.entries(pick.probabilities).some(([c, p]) => c !== "none" && p >= 0.1 && done(c))) return false;
  const merged: Record<string, number> = {};
  for (const [c, p] of Object.entries(pick.probabilities))
    merged[done(c) ? "none" : c] = (merged[done(c) ? "none" : c] ?? 0) + p;
  return (
    gate({ ...pick, choice: "none", probabilities: merged }, confidence(pick).target, GATE_TARGET_MARGIN) &&
    Object.entries(merged).every(([c, p]) => c === "none" || p < merged.none)
  );
}

/** An element like `el` (role, name or text) inside a named element like `to` on `obs`; unnamed targets cannot be told apart. */
function landed(obs: Observation, el: Element, to: Element): boolean {
  if (!to.name) return false;
  const id = (e: Element) => `${e.role}|${e.name || e.value}`;
  return obs.elements.some((e) => {
    if (id(e) !== id(el)) return false;
    for (let p = e.parent; p; p = p.parent) if (p.role === to.role && p.name === to.name) return true;
    return false;
  });
}

/** The element is a toggle in the Step's wanted state, or a checked radio (radios cannot be unchecked). */
const toggled = (e: { role: string; state: string }, goal: boolean | undefined) =>
  goal !== undefined && (TOGGLES.has(e.role) || (e.role === "radio" && goal)) && /\[checked\]/.test(e.state) === goal;
/** The browser Action for each target action (decision.ts ACTIONS); `press <key>` is PRESS. */
const VERBS: Record<string, Action["verb"]> = {
  click: "CLICK",
  type: "TYPE",
  select: "SELECT",
  upload: "UPLOAD",
  paste: "PASTE",
  hover: "HOVER",
  "double click": "DBLCLICK",
  "right click": "RIGHTCLICK",
  drag: "DRAG",
  "scroll down": "SCROLL",
  "scroll up": "SCROLL_UP",
  wait: "WAIT",
  back: "BACK",
  forward: "FORWARD",
  reload: "RELOAD",
  "close tab": "CLOSE_TAB",
  "switch tab": "SWITCH_TAB",
  enter: "ENTER",
};

/** The likeliest action `target` can do; not gated (task 0065: restricted, the right one can be far below 0.5). */
function likeliest(t: TurnAnswer, target: Element | typeof PAGE, obs: Observation, keys: string[]): string | undefined {
  const can = capabilities(target, obs, keys);
  return !t.action
    ? can[0]
    : Object.entries(t.action.probabilities)
        .filter(([a]) => can.includes(a))
        .sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Jev resolves what the check means and which element or area it is about; code decides pass/fail (check.ts).
 * `judged` opts in to fuzzy checks, which Jev answers directly and are reported as JUDGED_*, never PASSED.
 * `earlier`: quoted values from this scenario's earlier Steps (value -> Step), for checks that quote none.
 * `arg`: a doc string is one more quoted value; a one-column table is a list of values that must all be shown, a wider
 * one is matched row by row to the page table under its column headers.
 */
export async function runAssertion(
  step: string,
  rt: Runtime,
  decider: Decider,
  log = console.log,
  judged = false,
  earlier: Record<string, string> = {},
  arg: StepArgument = {},
  intent?: Intent,
  deadline = Date.now() + settings().checkTimeout,
): Promise<StepResult> {
  const { label: said, values, list, exact } = withIntent(readStep({ text: step, kind: "assertion", ...arg }), intent); // said: what Jev reads, with the table or doc string
  log(`\nAssert: ${said}`);
  const end = finish(log);
  const { table } = arg;
  if (table && !list && table.length < 2)
    return end(
      "UNVERIFIABLE",
      "the table has only its header row (a check's first row names the columns), so there is no row to compare",
    );
  let recallNote = "";
  let recall: Pick | undefined;
  if (!values.length && !table && Object.keys(earlier).length) {
    const r = await decider.recall(said, earlier);
    log(`  Recall: ${fmt(r)}`);
    if (gate(r) && r.choice !== "none") {
      values.push(r.choice);
      recall = r;
    } else recallNote = `; Jev could not tell which earlier value it refers to (${named(r)})`;
  }

  // One temporal policy (issue #81), like Playwright's expect: a check that does not pass is evaluated again whenever
  // the UI changes, until its deadline. Only a pass on valid evidence ends it early (and a check code cannot compare).
  // At the deadline, or once the page has nothing left that could change it: a known contradiction is
  // ASSERTION_FAILED, evidence still missing UNVERIFIABLE, conflicting meanings AMBIGUOUS. Jev is asked again only
  // after a change.
  let assessed: { text: string; a: Assessment } | undefined;
  // Looking again at an unchanged page (a request in flight) logs nothing new.
  let logged = { details: "", waiting: "" };
  let obs = await rt.observe();
  for (;;) {
    let verdict: Verdict;
    [obs, verdict] = await settled(rt, obs, check);
    const outcome = verdict.outcome === "PENDING" ? "UNVERIFIABLE" : verdict.outcome;
    const final = ["PASSED", "JUDGED_PASSED", "UNVERIFIABLE"].includes(verdict.outcome);
    const left = deadline - Date.now();
    if (outcome === "UNVERIFIABLE") verdict.reason = `${verdict.reason ?? ""}${recallNote}`;
    const details = `${obs.text}\n${verdict.details.join("\n")}`;
    if (details !== logged.details) {
      for (const line of verdict.details) log(line);
      logged = { details, waiting: "" };
    }
    if (final || left <= 0) return end(outcome, verdict.reason, verdict.marginal);
    const waiting =
      verdict.outcome === "PENDING"
        ? `  (not known yet: ${verdict.reason}; waiting for the UI to change)`
        : "  (not passed yet; waiting for the UI to change)";
    if (waiting !== logged.waiting) log(waiting);
    logged.waiting = waiting;
    // A request still in flight may change the page after it has gone quiet: look again until it ends.
    if (!(await rt.waitForChange(obs.text, left)) && !obs.loading) return end(outcome, verdict.reason);
    obs = await rt.observe();
  }

  async function check(obs: Observation): Promise<Verdict> {
    // The same page as last time (a request ended, the page did not change): the same answer, Jev is not asked again.
    if (assessed?.text !== obs.text) assessed = { text: obs.text, a: await decider.assess(said, obs, judged) };
    const v = checkVerdict(assessed.a, obs, { values, table, list, exact, recall });
    decider.read?.(v.reads ?? []);
    return v;
  }
}

/**
 * A click on a lookalike of what the Step quotes: the target's name shares a word with a quote and adds one the quote
 * lacks, and neither it nor its row/card (nearest ref'd parent) contains any quote ("Publish again" for "Publish now").
 * Returns the quotes it misses. A name made only of the quote's words may lead to it ("Publish" opens "Publish now").
 * A target sharing no word is left to Jev: the quote may be a value to type later ("Rename" for "Ada"). Quotes shown
 * as a field's value were typed, and secrets name no control: neither counts.
 */
function offQuote(el: Element, quoted: string[], obs: Observation): string | undefined {
  const has = (text: string | undefined, q: string) => !!text && text.toLowerCase().includes(q.toLowerCase());
  const words = (s: string) => s.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  const names = quoted.filter(
    (q) => !placeholder(q) && !obs.elements.some((e) => e.verb !== "CLICK" && has(e.value, q)),
  );
  if (names.some((q) => has(el.text, q) || has(el.parent?.text, q))) return undefined;
  const own = new Set(words(el.name));
  const lookalike = (q: string) => {
    const qw = new Set(words(q));
    return [...own].some((w) => qw.has(w)) && [...own].some((w) => !qw.has(w));
  };
  const like = names.filter(lookalike);
  return like.length ? like.map((q) => `"${q}"`).join(" or ") : undefined;
}

const finish =
  (log: typeof console.log) =>
  (outcome: StepOutcome, reason?: string, weak: string[] = []): StepResult => {
    const marginal = weak.length ? weak.join("; ") : undefined;
    log(`  => ${outcome}${reason ? `: ${reason}` : ""}${marginal ? ` (marginal: ${marginal})` : ""}`);
    return { outcome, reason, ...(marginal ? { marginal } : {}) };
  };

/** Outcomes where the Step could not find its way on the page: a failed request of that page is the likelier cause. */
const BLOCKING = new Set<StepOutcome>(["AMBIGUOUS", "BLOCKED", "ELEMENT_NOT_FOUND", "STEP_TIMEOUT"]);

/**
 * What a failed request means for a page that lacks what a Step needs: a server error, a rate limit, or no response.
 * Other 4xx (a 401 probe for a signed-out visitor, a 404 the app expects) do not leave the page incomplete.
 */
export function failureOutcome(f: FailedRequest): StepOutcome | undefined {
  if (f.status === undefined) return "NETWORK_ERROR";
  if (f.status === 429) return "RATE_LIMITED";
  return f.status >= 500 ? "APP_ERROR" : undefined;
}

/**
 * Jev's answer about a blocked Step's failed requests, read as two decisions. Were the Step's requests among the
 * failures? All requests together against none: several failed requests the Step needs split Jev's confidence among
 * them, and that must not hide the failure. Which kind? The outcome whose requests hold the most of that confidence;
 * its requests, likeliest first, name it.
 */
export function blockedBy(
  pick: Pick,
  failed: FailedRequest[],
): { outcome: StepOutcome; requests: FailedRequest[] } | undefined {
  const p = (i: number) => pick.probabilities[`r${i}`] ?? 0;
  const none = pick.probabilities.none ?? 0;
  // `r<i>` is a position in the list Jev was shown: other failures are skipped in place, never filtered out.
  const any = failed.reduce((sum, f, i) => sum + (failureOutcome(f) ? p(i) : 0), 0);
  // gate() checks the top answer's confidence, not which answer is on top: a sure "none" passes it too.
  if (any <= none || !gate({ choice: "failed", probabilities: { failed: any, none } })) return undefined;
  const mass = new Map<StepOutcome, number>();
  failed.forEach((f, i) => {
    const o = failureOutcome(f);
    if (o) mass.set(o, (mass.get(o) ?? 0) + p(i));
  });
  const outcome = [...mass].sort((a, b) => b[1] - a[1])[0][0];
  const requests = failed
    .map((f, i) => ({ f, p: p(i) }))
    .filter(({ f, p }) => p > 0 && failureOutcome(f) === outcome)
    .sort((a, b) => b.p - a.p)
    .map(({ f }) => f);
  return { outcome, requests };
}

/** Why a blocked Step's page lacks what it needs, if its failed requests say so (a tracker on a dead host fails too). */
async function blockingFailure(step: string, obs: Observation, rt: Runtime, decider: Decider, log: typeof console.log) {
  const failed = [
    ...new Map((rt.failedRequests?.() ?? []).filter(failureOutcome).map((f) => [describeFailure(f), f])).values(),
  ].slice(-MAX_FAILED);
  if (!failed.length || !decider.failure) return undefined;
  const pick = await decider.failure(step, obs, failed.map(describeFailure));
  log(`  Failed request: ${fmt(pick)}`);
  return blockedBy(pick, failed);
}
const MAX_FAILED = 20; // the latest: a long-lived page piles up failed polls

/** The page's failed requests as reported with a Step: each once, the latest MAX_FAILED. */
export const failedLines = (rt: Runtime) =>
  [...new Set((rt.failedRequests?.() ?? []).map(describeFailure))].slice(-MAX_FAILED);

/**
 * Action or Attempt step. An Attempt is done once its actions are performed, even if the app rejects them.
 * `docString`: one more value to type, read by Jev with the Step.
 */
export async function runStep(
  step: string,
  rt: Runtime,
  decider: Decider,
  log = console.log,
  attempt = false,
  docString?: string,
  intent?: Intent,
  scenario?: ScenarioLines,
): Promise<StepResult> {
  return rt.actionStep(() => act(step, rt, decider, log, attempt, docString, intent, scenario), log);
}

/**
 * How to answer the open dialog: Cancel unless Jev is sure the Step means OK (or one of its quoted values, for a
 * prompt). An alert, or a prompt the Step quotes nothing for, has no other answer, so Jev is not asked.
 */
async function answerDialog(
  dialog: Dialog,
  said: string,
  values: string[],
  obs: Observation,
  decider: Decider,
  log: typeof console.log,
): Promise<Action> {
  const answers = dialog.type === "alert" ? [] : dialog.type === "prompt" ? values : ["accept"];
  if (!answers.length) return { verb: "DISMISS" };
  const p = await decider.dialog(said, obs, [...answers, "dismiss"]);
  log(`  Dialog answer: ${fmt(p)}`);
  if (!gate(p) || p.choice === "dismiss") return { verb: "DISMISS" };
  return dialog.type === "prompt" ? { verb: "ACCEPT", value: p.choice } : { verb: "ACCEPT" };
}

async function act(
  step: string,
  rt: Runtime,
  decider: Decider,
  log: typeof console.log,
  attempt: boolean,
  docString?: string,
  intent?: Intent,
  scenario?: ScenarioLines,
): Promise<StepResult> {
  const read = withIntent(readStep({ text: step, kind: "action", docString }), intent);
  attempt ||= !!read.attempt;
  const said = read.label;
  log(`\n${attempt ? "Attempt" : "Step"}: ${said}`);
  const done = finish(log);
  // Only "press X" or "go back" / "go to /x": nothing to choose, so code does it and the following checks verify the
  // effect (tasks 0039, 0041).
  const only: Action | undefined = read.pressOnly ? { verb: "PRESS", value: read.pressOnly } : read.navigation;
  if (only) {
    const described = `${only.verb}${only.value === undefined ? "" : ` ${only.value}`}`;
    log(`  Execute: ${described}`);
    try {
      await rt.execute(only);
    } catch (err) {
      return done("ACTION_FAILED", `${described} failed: ${(err as Error).message.split("\n")[0]}`);
    }
    return done("DONE");
  }
  const recent: string[] = []; // this Step's actions, sent to Jev so it knows what it already did
  let unchanged = 0;
  let obs = await rt.observe();
  // A Step blocked on a page whose requests failed reports the failure, not Jev's doubt about a page without the
  // controls it needs (a record that failed to load is not an ambiguous Step).
  const end = async (outcome: StepOutcome, reason?: string, weak?: string[]): Promise<StepResult> => {
    const f = BLOCKING.has(outcome) ? await blockingFailure(said, obs, rt, decider, log) : undefined;
    const why = f?.requests.slice(0, 3).map(describeFailure).join(", ");
    return f ? done(f.outcome, `${why}${reason ? ` (${outcome}: ${reason})` : ""}`) : done(outcome, reason, weak);
  };

  const { maxTurns } = settings();
  for (let turn = 1; turn <= maxTurns; turn++) {
    log(`\n  Observation #${turn}:`);
    for (const e of obs.elements) log(`    [${e.ref}] ${e.line}`);

    // An open dialog blocks the page: this Turn answers it, nothing else.
    if (obs.dialog?.state === "open") {
      const action = await answerDialog(obs.dialog, said, read.values, obs, decider, log);
      const described = `${action.verb} ${obs.dialog.type} "${obs.dialog.message}"${action.value === undefined ? "" : ` <- "${action.value}"`}`;
      log(`  Execute: ${described}`);
      try {
        await rt.execute(action);
      } catch (err) {
        return end("ACTION_FAILED", `${described} failed: ${(err as Error).message.split("\n")[0]}`);
      }
      recent.push(described);
      obs = await rt.observe();
      unchanged = 0;
      continue;
    }

    let t: TurnAnswer;
    [obs, t] = await settled(rt, obs, (o) => decider.turn(said, o, recent, attempt, read.keys));
    t = { ...t, target: grouped(t.target, obs, t.action) }; // equivalent targets count as one (task 0065)
    log(`  Decision: done=${t.done.toFixed(2)}${t.action ? ` action: ${fmt(t.action)}` : ""} target: ${fmt(t.target)}`);
    if (t.done >= DONE_THRESHOLD) return end("DONE");
    if (recent.length && unchanged === 0 && t.target.choice === "none" && t.done >= DONE_AFTER_ACTION)
      return end("DONE");
    // Where the Step ends: once it has acted, the likeliest next element may be a later Step's (SauceDemo "I continue"
    // then Finish, "I run the workflow" then the confirm dialog of "I confirm with ...", TodoMVC typing the todo again).
    // Asked before the gate: a split between that element and "none" is the same ending (scripts/bench-owner.ts).
    const top = obs.elements.find((e) => e.ref === t.target.choice);
    const topHow = top && likeliest(t, top, obs, read.keys);
    if (recent.length && top && topHow && scenario && scenario.lines.length > 1 && decider.owner) {
      const o = await decider.owner(said, obs, recent, top, topHow, scenario);
      log(`  Owner: ${fmt(o)}`);
      if (o.choice === "other") return end("DONE");
    }
    if (alreadyToggled(t.target, obs, read.toggle)) {
      log("  Toggle: already done");
      return end("DONE");
    }
    if (!gate(t.target, confidence(t.target).target, GATE_TARGET_MARGIN))
      return end("AMBIGUOUS", `Jev is unsure what to do next: ${named(t.target, obs)}`);
    if (t.target.choice === "none") return end("BLOCKED", "nothing on this screen helps do the step");

    const el = t.target.choice === PAGE ? undefined : obs.elements.find((e) => e.ref === t.target.choice);
    if (t.target.choice !== PAGE && !el)
      return end("ELEMENT_NOT_FOUND", `Jev chose an element that is no longer on the page (${t.target.choice})`);
    const how = likeliest(t, el ?? PAGE, obs, read.keys);
    // Only a recorded answer can miss (live answers rate every action): it was not offered this Turn.
    if (!how)
      return end(
        "ELEMENT_NOT_FOUND",
        `Jev chose ${t.action?.choice} on ${el?.line ?? "the page"}, which is not offered now`,
      );
    const key = /^press (.+)$/.exec(how)?.[1];
    let action: Action;
    let described: string;
    let dropOn: Element | undefined;
    if (!el) {
      action = key ? { verb: "PRESS", value: key } : { verb: VERBS[how] };
      described = key ? `PRESS ${key}` : action.verb;
    } else {
      if (el.verb === "CLICK" && toggled(el, read.toggle)) {
        log(`  Toggle: already ${el.line}`);
        return end("DONE");
      }
      const off = VERBS[how] === "CLICK" && offQuote(el, read.quoted, obs);
      if (off) return end("AMBIGUOUS", `Jev chose ${el.line}, which is not ${off}`);
      action = { verb: VERBS[how], ref: el.ref };
      let onto = "";
      if (action.verb === "DRAG") {
        const d = await decider.drop(said, obs, el);
        log(`  Drop: ${fmt(d)}`);
        if (!gate(d, confidence(d).target, GATE_TARGET_MARGIN) || d.choice === "none")
          return end("AMBIGUOUS", `Jev is unsure where to drop ${el.line}: ${named(d, obs)}`);
        action.to = d.choice;
        const to = (dropOn = [...obs.readable, ...obs.areas].find((e) => e.ref === d.choice)!);
        onto = ` onto ${to.role} "${to.name || to.value.slice(0, 60)}"`;
      }
      if (action.verb === "TYPE" || action.verb === "SELECT" || action.verb === "UPLOAD") {
        // A file to upload is only ever one the Step quotes (task 0044).
        const candidates = el.verb === "SELECT" ? el.options : action.verb === "UPLOAD" ? read.quoted : read.candidates;
        if (!candidates.length) {
          return end(
            "AMBIGUOUS",
            `the step gives no value to enter into ${el.line}; quote it (e.g. enter "Winter Sale")`,
          );
        }
        // A clear Step that quotes nothing allows only "": no question (task 0067: Jev's "" 79% missed the gate).
        const v =
          candidates.length === 1 && candidates[0] === "" && action.verb === "TYPE"
            ? { choice: "", probabilities: { "": 1 } }
            : await decider.value(said, obs, el, candidates);
        log(`  Value: ${el.secret ? "(secret)" : fmt(v)}`);
        if (!gate(v) || v.choice === "none")
          return end(
            "AMBIGUOUS",
            `Jev is unsure which value to enter into ${el.line}${el.secret ? "" : `: ${named(v)}`}`,
          );
        action.value = v.choice;
      }
      const shown = action.value === undefined ? "" : ` <- "${el.secret ? MASK : action.value}"`;
      described = `${action.verb} ${el.role} "${el.name || el.value.slice(0, 60)}"${shown}${onto}`;
    }
    // The page moved on its own since the Turn's Observation: diff from now, so that change is not the action's.
    const before = (await rt.stale?.()) ? await rt.observe() : obs;
    log(`  Execute: ${described}`);
    try {
      await rt.execute(action);
    } catch (err) {
      return end("ACTION_FAILED", `${described} failed: ${(err as Error).message.split("\n")[0]}`);
    }
    if (el) decider.acted?.(el.ref);

    let next = await rt.observe();
    // An effect can land a task or a request later (replay does not settle after actions): wait for it before calling
    // the action ineffective. Returns at once on a page with nothing pending.
    if (changes(before, next, action.ref) === "no visible change" && (await rt.waitForChange(next.text)))
      next = await rt.observe();
    // What the action changed, for Jev's next `done` (task 0066: under-confident after working actions).
    const effect = changes(before, next, action.ref);
    log(`  Effect: ${effect}`);
    if (t.target.confirmed) return end("DONE");
    recent.push(`${described} -> ${effect}`);
    // Drag effect check (task 0065): Jev's done stayed 0.57-0.73 with the item shown in its new list, any wording.
    if (action.verb === "DRAG" && el && dropOn && !landed(obs, el, dropOn) && landed(next, el, dropOn)) {
      log(`  Drag: ${el.line} is now in ${dropOn.role} "${dropOn.name}"`);
      return end("DONE");
    }
    const box =
      action.verb === "CLICK" ? next.elements.find((e) => e.ref === action.ref && toggled(e, read.toggle)) : undefined;
    if (box) {
      log(`  Toggle: ${box.line}`);
      return end("DONE");
    }
    // By the effect, not the raw text: focus alone ([active]) is no change (task 0067, false DONE on the hover menu).
    unchanged = effect === "no visible change" ? unchanged + 1 : 0;
    if (unchanged >= 2) return end("BLOCKED", `the page did not change after two actions (last: ${described})`);
    obs = next;
  }
  return end("STEP_TIMEOUT", `not done after ${maxTurns} actions (${recent.join(", ")})`);
}
