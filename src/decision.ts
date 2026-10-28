// The Decision module (task 0053): the seam to the decision model (Decider), the answers its questions can have, the
// confidence gates, and the tracing every answer gets. Jev (jev.ts) and the tests' scripted fakes are its adapters; cassette.ts replays answers across it.
import { settings, type Settings } from "./options.ts";
import type { Element, Observation } from "./observation.ts";

export interface Pick {
  choice: string;
  probabilities: Record<string, number>;
  /** Replay keeps the confidence used to record this answer, not the current run’s gates. */
  recordedConfidence?: Settings["confidence"];
}
export const confidence = (pick: Pick) => pick.recordedConfidence ?? settings().confidence;

export interface TurnAnswer {
  done: number; // P(step already accomplished)
  target: Pick; // element ref, PAGE, or "none"
  /** How to use the target, an ACTIONS key or `press <key>` (task 0065); only the target's capabilities count. Absent: its first. */
  action?: Pick;
}

/** The page itself as a target (task 0065): scrolling it, history, tabs, keys, waiting. */
export const PAGE = "page";

/** Everything a target can be used for (task 0065, ADR 0005); capabilities() picks a target's own. */
export const ACTIONS = {
  click: "Click it.",
  type: "Type a value from `step` into it (an empty value clears it).",
  select: "Select an option in it.",
  upload: "Click it to choose a file to upload, one `step` names.",
  paste: "Paste the copied text into it.",
  hover: "Only hover over it with the mouse pointer (e.g. to open a menu or show a tooltip).",
  "double click": "Double-click it (e.g. to edit it inline).",
  "right click": "Right-click it (e.g. to open its context menu).",
  drag: "Drag it with the mouse and drop it onto another element (e.g. to reorder it or move it to another list).",
  "scroll down":
    "Scroll it down: show or load more of its content further down (the page: the needed element may load further down).",
  "scroll up": "Scroll it up: show or load more of its content further up.",
  wait: "Wait: the page is still loading what is needed.",
  back: "Go back to the previous page in the browser history.",
  forward: "Go forward in the browser history.",
  reload: "Reload the page.",
  "close tab": "Close this browser tab and return to the previous one.",
  "switch tab": "Switch to the previous browser tab, keeping this one open.",
  enter: "Press Enter in it, to submit what was typed (e.g. run a search).",
} as const;

/**
 * What `target` can be used for. Elements: their role's verb (a typeable field also takes paste, a clickable one an
 * upload), click-like gestures on every target (no DOM evidence for them, task 0064), drag/scroll only with the fact.
 * The page: scroll, wait, history; tabs while more than one is open; keys the Step names (`keys`, task 0039). Enter:
 * the focused text field's.
 */
export function capabilities(target: Element | typeof PAGE, obs: Observation, keys: string[] = []): string[] {
  if (target === PAGE)
    return [
      "scroll down",
      "scroll up",
      "wait",
      "back",
      "forward",
      "reload",
      ...(obs.readable.some((e) => e.ref === "tabs") ? ["close tab", "switch tab"] : []),
      ...keys.filter((k) => k !== "Enter").map((k) => `press ${k}`),
    ];
  // Enter goes to the focused field: offered there, so the field is the target (as the page, Jev split it with the
  // Search button: 0.47 / 0.29, AMBIGUOUS on Wikipedia).
  const own =
    target.verb === "TYPE"
      ? ["type", "paste", ...(/\[active\]/.test(target.state) ? ["enter"] : [])]
      : target.verb === "SELECT"
        ? ["select"]
        : ["click", "upload"];
  return [
    ...own,
    "hover",
    "double click",
    "right click",
    ...(/\[draggable\]/.test(target.state) ? ["drag"] : []),
    ...(/\[scrollable\]/.test(target.state) ? ["scroll down", "scroll up"] : []),
  ];
}

/** Choice text of an action: ACTIONS, or a key the Step names. */
export const describeAction = (a: string) =>
  ACTIONS[a as keyof typeof ACTIONS] ?? `Press the ${a.slice(6)} key, as \`step\` says.`;

/**
 * Equivalent targets sum their confidence before the gate (task 0065, 0057): links with the same name and URL lead to
 * the same page (Wikipedia's two `Deutsch` links, 42% / 38%). The first keeps the sum. Buttons never: their handlers
 * may differ.
 */
export function grouped(p: Pick, obs: Observation): Pick {
  const first = new Map<string, string>();
  const probabilities: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.probabilities)) {
    const e = obs.elements.find((x) => x.ref === k);
    const id = e?.role === "link" && e.url ? `${e.name}|${e.url}` : undefined;
    const into = id ? (first.get(id) ?? (first.set(id, k), k)) : k;
    probabilities[into] = (probabilities[into] ?? 0) + v;
  }
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? p.choice;
  return { ...p, choice, probabilities };
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
  disabled: "disabled",
  enabled: "enabled (not disabled)",
  checked: "checked",
  unchecked: "not checked",
  expanded: "expanded / open",
  collapsed: "collapsed / closed",
  selected: "selected",
  unselected: "not selected",
  pressed: "pressed / toggled on",
  unpressed: "not pressed / toggled off",
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
  none: "nothing",
  [AREA_PAGE]: "anywhere on the page",
  [AREA_MISSING]: "an area not on this screen",
};
/** A Jev answer for people: element refs replaced by the element, top 3 as percentages. */
export const named = (p: Pick, obs?: Observation) =>
  Object.entries(p.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => {
      const el = obs && [...obs.readable, ...obs.areas, ...obs.elements].find((e) => e.ref === k);
      return `${el ? el.line : (SPECIAL[k] ?? k)} ${Math.round(v * 100)}%`;
    })
    .join(", ");

export const fmt = (p: Pick) =>
  Object.entries(p.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(" ");

/** The seam to the decision model: Jev implements it (jev.ts); tests use a scripted fake. */
export interface Decider {
  /** `recent`: this Step's actions so far, oldest first, e.g. `CLICK combobox "Activation period"`. */
  /** `attempt`: done means the user performed the actions, whether or not the app accepted them. */
  /** `keys`: the Named keys the Step's text names (readStep), offered as the page's `press <key>` actions. */
  turn(step: string, obs: Observation, recent: string[], attempt?: boolean, keys?: string[]): Promise<TurnAnswer>;
  value(step: string, obs: Observation, el: Element, candidates: string[]): Promise<Pick>;
  /** Drag: the readable element or area to drop `source` onto, or "none" (task 0045). */
  drop(step: string, obs: Observation, source: Element): Promise<Pick>;
  /** Assertion steps: what kind of check, and which element it is about. Code decides pass/fail. */
  assess(step: string, obs: Observation, judged: boolean): Promise<Assessment>;
  /** Memory: which value from an earlier Step (`earlier`: value -> Step it came from) the check refers to, or "none". */
  recall(step: string, earlier: Record<string, string>): Promise<Pick>;
  /** The open browser dialog (`obs.dialog`): "accept", "dismiss", or for a prompt one of the Step's quoted values. */
  dialog(step: string, obs: Observation, answers: string[]): Promise<Pick>;
}

/**
 * Thrown by a Decider that needs a later Observation (a replayed control not on a still-loading page): the runner
 * waits for the page to change and asks again, and throws `final` once `checkTimeout` has passed.
 */
export class NotYet extends Error {
  final: Error;
  constructor(final: Error) {
    super(final.message);
    this.final = final;
  }
}

/** Confidence gate: act only on a clear, confident top answer. The top is `confidence.answer` (default 0.8, src/options.ts). */
export const GATE_TOP = 0.8;
export const GATE_MARGIN = 0.3;
/**
 * Which element to act on is gated lower than a check (task 0002): a wrong action fails a later Step loudly,
 * while a wrong check can pass falsely. Fitted on 26 labelled AMBIGUOUS Turns from the real-site corpus, where
 * every top answer naming an element was the right one down to 0.47; below 0.1 margin the two answers are a coin flip.
 */
export const GATE_TARGET_TOP = 0.5; // default of `confidence.target`
export const GATE_TARGET_MARGIN = 0.1;
export function gate(pick: Pick, minTop = confidence(pick).answer, minMargin = GATE_MARGIN): boolean {
  const [top = 0, second = 0] = Object.values(pick.probabilities).sort((a, b) => b - a);
  return top >= minTop && top - second >= minMargin;
}

/** Most likely answers first, until together they cover the gate's confidence (cassette.ts stores exactly these). */
export function plausible(pick: Pick, coverage = confidence(pick).answer): string[] {
  const out: string[] = [];
  let covered = 0;
  for (const [k, p] of Object.entries(pick.probabilities).sort((x, y) => y[1] - x[1])) {
    if (covered >= coverage) break;
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
        const extra =
          question === "value"
            ? { element: el.line, answer: el.secret ? "(secret)" : answer }
            : question === "dialog"
              ? { dialog: (args[1] as Observation).dialog, answer }
              : { answer };
        event(question, { step: args[0], ...extra });
        return answer;
      };
    },
  });
}
