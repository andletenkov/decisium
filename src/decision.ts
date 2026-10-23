// The Decision module (task 0053): the seam to the decision model (Decider), the confidence gates, and the tracing every
// answer gets. Jev (jev.ts) and the tests' scripted fakes are its adapters; cassette.ts replays answers across it.
import type { Element, Observation } from "./observation.ts";

export interface Pick {
  choice: string;
  probabilities: Record<string, number>;
}

export interface TurnAnswer {
  done: number; // P(step already accomplished)
  target: Pick; // element ref, a pageActions() key, or "none"
}

export interface Assessment {
  kind: Pick;
  subject: Pick; // element ref the check is about, or "none"
  area: Pick; // presence/absence: element ref of the area the check names, AREA_PAGE, or AREA_MISSING
  state: Pick; // required control state, used by `state` checks
  judged?: number; // P(step holds), only when asked
}

export const AREA_PAGE = "page";
export const AREA_MISSING = "missing";

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
 * `d` with each answer written as a trace event named after its question (turn, value, assess...): the Step and the
 * answer, so a new question is traced without code here. A value chosen for a Secret field is masked; a dialog answer
 * carries the dialog.
 */
export function traced(d: Decider, event: (type: string, data: Record<string, unknown>) => void): Decider {
  return new Proxy(d, {
    get(target, question: string) {
      const ask: unknown = Reflect.get(target, question);
      if (typeof ask !== "function") return ask;
      return async (...args: unknown[]) => {
        const answer = await ask.apply(target, args);
        const [step, obs, el] = args as [string, Observation, Element];
        event(question, { step, ...question === "value" ? { element: el.line, answer: el.secret ? "(secret)" : answer }
          : question === "dialog" ? { dialog: obs.dialog, answer } : { answer } });
        return answer;
      };
    },
  });
}
