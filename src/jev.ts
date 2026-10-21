import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Cassette } from "./cassette.ts";
import type { Element, Observation } from "./observation.ts";

export const MODEL = "jev-1.14.0";

export interface Pick {
  choice: string;
  probabilities: Record<string, number>;
}

export interface TurnAnswer {
  done: number; // P(step already accomplished)
  target: Pick; // element ref, a pageActions() key, or "none"
}

/** Non-element moves offered next to the element refs. */
export const PAGE_ACTIONS = {
  scroll: "Scroll down: the needed element is not in `ui` yet and may load further down the page.",
  wait: "Wait: `ui` is still loading the needed element.",
} as const;
const ENTER = "Press Enter in the focused field, to submit what was typed (e.g. run a search).";

/** Page actions for this Observation: Enter only while a text field has focus, so it is not offered on every Turn. */
export const pageActions = (obs: Observation): Record<string, string> =>
  obs.elements.some(e => e.verb === "TYPE" && /\[active\]/.test(e.state)) ? { ...PAGE_ACTIONS, enter: ENTER } : PAGE_ACTIONS;

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

/** The decision layer. Jev implements it; tests use a scripted fake. */
export interface Decider {
  /** `recent`: this Step's actions so far, oldest first, e.g. `CLICK combobox "Activation period"`. */
  /** `attempt`: done means the user performed the actions, whether or not the app accepted them. */
  turn(step: string, obs: Observation, recent: string[], attempt?: boolean): Promise<TurnAnswer>;
  value(step: string, obs: Observation, el: Element, candidates: string[]): Promise<Pick>;
  /** Assertion steps: what kind of check, and which element it is about. Code decides pass/fail. */
  assess(step: string, obs: Observation, judged: boolean): Promise<Assessment>;
  /** Memory: which value from an earlier Step (`earlier`: value -> Step it came from) the check refers to, or "none". */
  recall(step: string, earlier: Record<string, string>): Promise<Pick>;
}

const refs = (els: Element[]): Record<string, string> => Object.fromEntries(els.map(e => [e.ref, e.line]));

/** Jev API limit: options per choice question. */
export const MAX_CHOICES = 255;
const FINALISTS = 3; // kept from each batch

/**
 * Pages can offer more candidates than one question accepts (GitHub: 336 links and buttons). Ask in batches, keep each
 * batch's most likely candidates, repeat until they fit; the caller asks the real question over what is left, so the
 * confidence gate still reads one comparable distribution. `fixed` answers (none, scroll, ...) are in every batch.
 */
export async function narrow(candidates: Record<string, string>, fixed: Record<string, string>,
  ask: (criteria: Record<string, string>) => Promise<Pick>, max = MAX_CHOICES): Promise<Record<string, string>> {
  let left = Object.entries(candidates);
  const size = max - Object.keys(fixed).length;
  while (left.length > size) {
    const kept: [string, string][] = [];
    for (let i = 0; i < left.length; i += size) {
      const batch = left.slice(i, i + size);
      const { probabilities } = await ask({ ...Object.fromEntries(batch), ...fixed });
      const best = batch.map(([k]) => k).sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0)).slice(0, FINALISTS);
      kept.push(...batch.filter(([k]) => best.includes(k)));
    }
    left = kept;
  }
  return { ...Object.fromEntries(left), ...fixed };
}

/** Every question sends the Step text as-is, so a value quoted in a Step (a password included) reaches the API. */
export class JevDecider implements Decider {
  #client = new TypeSafeClient({ defaultModel: MODEL }); // reads TYPESAFE_API_KEY
  #cassette?: Cassette;
  constructor(cassette?: Cassette) { this.#cassette = cassette; }

  async #ask<Q extends Parameters<TypeSafeClient["systemOne"]>[0]>(request: Q) {
    const live = async () => {
      const res = await this.#client.systemOne(request);
        return { model: res.model, answers: res.answers as Record<string, any> };
    };
    return this.#cassette ? this.#cassette.call(request, live) : live();
  }

  /** One choice question over `criteria`, for narrow(). */
  #choose(state: Record<string, string | string[]>, question: string) {
    return async (criteria: Record<string, string>): Promise<Pick> =>
      (await this.#ask({ state, questions: { pick: choice(question, criteria) } })).answers.pick;
  }

  async turn(step: string, obs: Observation, recent: string[], attempt = false): Promise<TurnAnswer> {
    const state = { step, ui: obs.text, actions_taken_for_step: recent.length ? recent : "none yet" };
    const question = "Which element in `ui` should be interacted with next to accomplish `step`?";
    const targets = await narrow(refs(obs.elements), { none: "No element on screen helps accomplish `step`.", ...pageActions(obs) },
      this.#choose(state, question));
    const res = await this.#ask({
      state,
      questions: {
        done: attempt
          ? noul("Given `actions_taken_for_step`, has the user performed every action `step` asks for, regardless of whether the app accepted it?")
          : noul("Given `actions_taken_for_step`, does `ui` show that `step` has been fully accomplished?"),
        target: choice(question, targets),
      },
    });
    return { done: res.answers.done.noul, target: res.answers.target };
  }

  async recall(step: string, earlier: Record<string, string>): Promise<Pick> {
    const values = Object.keys(earlier);
    const criteria: Record<string, string> = Object.fromEntries(values.map((v, i) => [`v${i}`, `"${v}", from the earlier step: ${earlier[v]}`]));
    criteria.none = "`check` does not refer to any of these values.";
    const res = await this.#ask({
      state: { check: step },
      questions: { value: choice("`check` quotes no value. Which value from an earlier step of the same test does it refer to (e.g. \"the campaign\" meaning the campaign named earlier)?", criteria) },
    });
    const a: Pick = res.answers.value;
    const name = (k: string) => k === "none" ? k : values[Number(k.slice(1))] ?? k;
    return { choice: name(a.choice), probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([k, p]) => [name(k), p])) };
  }

  async value(step: string, obs: Observation, el: Element, candidates: string[]): Promise<Pick> {
    const state = { step, ui: obs.text, element: el.line };
    const question = "Which value should be entered into `element` to accomplish `step`?";
    const criteria = await narrow(Object.fromEntries(candidates.map((c, i) => [`v${i}`, c])),
      { none: "None of these values is what `step` asks for." }, this.#choose(state, question));
    const res = await this.#ask({ state, questions: { value: choice(question, criteria) } });
    const a: Pick = res.answers.value;
    // Map label keys back to the values so traces and execution use real text.
    const name = (k: string) => criteria[k] && k !== "none" ? criteria[k] : k;
    return {
      choice: name(a.choice),
      probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([k, p]) => [name(k), p])),
    };
  }

  async assess(step: string, obs: Observation, judged: boolean): Promise<Assessment> {
    const state = { check: step, ui: obs.text };
    const subjectQ = "Which element in `ui` is the one `check` is about, regardless of whether the check passes?";
    const areaQ = "Where does `check` say to look? Pick the element in `ui` that is that area (a list, table, section, dialog...), regardless of whether the check passes.";
    const subjects = await narrow(refs(obs.readable), { none: "No element in `ui` is the one `check` is about." }, this.#choose(state, subjectQ));
    const areas = await narrow(refs(obs.areas), {
      [AREA_PAGE]: "`check` names no specific area; anywhere on the page counts.",
      [AREA_MISSING]: "`check` names a specific area, but no element in `ui` is that area.",
    }, this.#choose(state, areaQ));
    const res = await this.#ask({
      state,
      questions: {
        kind: choice("What kind of check is `check`?", ASSERTION_KINDS),
        subject: choice(subjectQ, subjects),
        state: choice("Which control state does `check` require?", STATES),
        area: choice(areaQ, areas),
        ...(judged ? { judged: noul("Does `ui` satisfy `check`?") } : {}),
      },
    });
    const a = res.answers as typeof res.answers & { judged?: { noul: number } };
    return { kind: a.kind, subject: a.subject, area: a.area, state: a.state, judged: a.judged?.noul };
  }

}

/** Confidence gate: act only on a clear, confident top answer. */
export const GATE_TOP = 0.8;
/**
 * Which element to act on is gated lower than a check (task 0002): a wrong action fails a later Step loudly,
 * while a wrong check can pass falsely. Fitted on 26 labelled AMBIGUOUS Turns from the real-site corpus, where
 * every top answer naming an element was the right one down to 0.47; below 0.1 margin the two answers are a coin flip.
 */
export const GATE_TARGET_TOP = 0.5;
export const GATE_TARGET_MARGIN = 0.1;
export function gate(pick: Pick, minTop = GATE_TOP, minMargin = 0.3): boolean {
  const [top = 0, second = 0] = Object.values(pick.probabilities).sort((a, b) => b - a);
  return top >= minTop && top - second >= minMargin;
}
