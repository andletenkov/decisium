// The Decision module (task 0053): the seam to the decision model (Decider), the answers its questions can have, the
// confidence gates, and the tracing every answer gets. Jev (jev.ts) and the tests' scripted fakes are its adapters; cassette.ts replays answers across it.
import type { Element, Observation } from "./observation.ts";

export interface Pick {
  choice: string;
  probabilities: Record<string, number>;
}

export interface TurnAnswer {
  done: number; // P(step already accomplished)
  target: Pick; // element ref, a pageActions() key, or "none"
}

// The answers a question can have besides element refs: Jev is offered them, code reads them.
/** Non-element moves offered next to the element refs. */
const PAGE_ACTIONS = {
  scroll: "Scroll down: the needed element is not in `ui` yet and may load further down the page.",
  wait: "Wait: `ui` is still loading the needed element.",
  back: "Go back to the previous page in the browser history.",
  forward: "Go forward in the browser history.",
  reload: "Reload the page.",
} as const;
/** Offered only while more than one tab is open (the `tabs` pseudo-element). */
const TAB_ACTIONS = {
  "close tab": "Close this browser tab and return to the previous one.",
  "switch tab": "Switch to the previous browser tab, keeping this one open.",
} as const;
const ENTER = "Press Enter in the focused field, to submit what was typed (e.g. run a search).";

/**
 * Page actions for this Observation and Step: Enter only while a text field has focus, so it is not offered on every
 * Turn; other keys only when the Step names them (`keys`, "press Escape"), pressed wherever the focus is (task 0039).
 */
export function pageActions(obs: Observation, keys: string[]): Record<string, string> {
  const out: Record<string, string> = { ...PAGE_ACTIONS, ...obs.readable.some(e => e.ref === "tabs") ? TAB_ACTIONS : {} };
  if (obs.elements.some(e => e.verb === "TYPE" && /\[active\]/.test(e.state))) out.enter = ENTER;
  for (const key of keys) if (key !== "Enter") out[`press ${key}`] = `Press the ${key} key, as \`step\` says.`;
  return out;
}

export const ASSERTION_KINDS = {
  value: "Checks that some element shows a specific text or value.",
  presence: "Checks that something is shown or exists on the page.",
  absence: "Checks that something is not shown or does not exist on the page.",
  state: "Checks whether a control is disabled, enabled, checked, expanded, selected or pressed.",
  fuzzy: "A subjective or holistic check that none of the other kinds can express.",
} as const;

/** State labels Jev can pick; code reads the matching snapshot flag. */
export const STATES = {
  disabled: "disabled", enabled: "enabled (not disabled)",
  checked: "checked", unchecked: "not checked",
  expanded: "expanded / open", collapsed: "collapsed / closed",
  selected: "selected", unselected: "not selected",
  pressed: "pressed / toggled on", unpressed: "not pressed / toggled off",
} as const;

export interface Assessment {
  kind: Pick;
  subject: Pick; // element ref the check is about, or "none"
  area: Pick; // presence/absence: element ref of the area the check names, AREA_PAGE, or AREA_MISSING
  state: Pick; // required control state, used by `state` checks
  judged?: number; // P(step holds), only when asked
}

export const AREA_PAGE = "page";
export const AREA_MISSING = "missing";

const SPECIAL: Record<string, string> = {
  none: "nothing", [AREA_PAGE]: "anywhere on the page", [AREA_MISSING]: "an area not on this screen",
  scroll: "scroll down", wait: "wait for loading", enter: "press Enter", back: "go back", forward: "go forward", reload: "reload",
};
/** A Jev answer for people: element refs replaced by the element, top 3 as percentages. */
export const named = (p: Pick, obs?: Observation) =>
  Object.entries(p.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => {
    const el = obs && [...obs.readable, ...obs.areas, ...obs.elements].find(e => e.ref === k);
    return `${el ? el.line : SPECIAL[k] ?? k} ${Math.round(v * 100)}%`;
  }).join(", ");

export const fmt = (p: Pick) =>
  Object.entries(p.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");

/** The seam to the decision model: Jev implements it (jev.ts); tests use a scripted fake. */
export interface Decider {
  /** `recent`: this Step's actions so far, oldest first, e.g. `CLICK combobox "Activation period"`. */
  /** `attempt`: done means the user performed the actions, whether or not the app accepted them. */
  /** `keys`: the Named keys the Step's text names (readStep), offered as `press <key>` next to the elements. */
  turn(step: string, obs: Observation, recent: string[], attempt?: boolean, keys?: string[]): Promise<TurnAnswer>;
  value(step: string, obs: Observation, el: Element, candidates: string[]): Promise<Pick>;
  /** Assertion steps: what kind of check, and which element it is about. Code decides pass/fail. */
  assess(step: string, obs: Observation, judged: boolean): Promise<Assessment>;
  /** Memory: which value from an earlier Step (`earlier`: value -> Step it came from) the check refers to, or "none". */
  recall(step: string, earlier: Record<string, string>): Promise<Pick>;
  /** The open browser dialog (`obs.dialog`): "accept", "dismiss", or for a prompt one of the Step's quoted values. */
  dialog(step: string, obs: Observation, answers: string[]): Promise<Pick>;
}

/**
 * Thrown by a Decider that needs a later Observation (a replayed control not on a still-loading page): the runner
 * waits for the page to change and asks again, and throws `final` once ASSERT_TIMEOUT_MS has passed.
 */
export class NotYet extends Error {
  final: Error;
  constructor(final: Error) { super(final.message); this.final = final; }
}

/** Confidence gate: act only on a clear, confident top answer. */
export const GATE_TOP = 0.8;
export const GATE_MARGIN = 0.3;
/**
 * Which element to act on is gated lower than a check (task 0002): a wrong action fails a later Step loudly,
 * while a wrong check can pass falsely. Fitted on 26 labelled AMBIGUOUS Turns from the real-site corpus, where
 * every top answer naming an element was the right one down to 0.47; below 0.1 margin the two answers are a coin flip.
 */
export const GATE_TARGET_TOP = 0.5;
export const GATE_TARGET_MARGIN = 0.1;
export function gate(pick: Pick, minTop = GATE_TOP, minMargin = GATE_MARGIN): boolean {
  const [top = 0, second = 0] = Object.values(pick.probabilities).sort((a, b) => b - a);
  return top >= minTop && top - second >= minMargin;
}

/** Most likely answers first, until together they cover the gate's confidence (cassette.ts stores exactly these). */
export function plausible(pick: Pick): string[] {
  const out: string[] = [];
  let covered = 0;
  for (const [k, p] of Object.entries(pick.probabilities).sort((x, y) => y[1] - x[1])) {
    if (covered >= GATE_TOP) break;
    out.push(k);
    covered += p;
  }
  return out;
}

/**
 * `d` with each answer written as a trace event named after its question (turn, value, assess...): the Step (every
 * question's first argument) and the answer. A question answering plainly needs no code here; a value chosen for a
 * Secret field is masked, and a dialog answer carries the dialog. Only Decider questions are reached through it.
 */
export function traced(d: Decider, event: (type: string, data: Record<string, unknown>) => void): Decider {
  return new Proxy(d, {
    get(target, question: string) {
      const ask: unknown = Reflect.get(target, question);
      if (typeof ask !== "function") return ask;
      return async (...args: unknown[]) => {
        const answer = await ask.apply(target, args);
        const el = args[2] as Element; // value(step, obs, el, candidates)
        const extra = question === "value" ? { element: el.line, answer: el.secret ? "(secret)" : answer }
          : question === "dialog" ? { dialog: (args[1] as Observation).dialog, answer } : { answer };
        event(question, { step: args[0], ...extra });
        return answer;
      };
    },
  });
}
