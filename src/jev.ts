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
  target: Pick; // element ref, a PAGE_ACTIONS key, or "none"
}

/** Non-element moves offered next to the element refs. */
export const PAGE_ACTIONS = {
  scroll: "Scroll down: the needed element is not in `ui` yet and may load further down the page.",
  wait: "Wait: `ui` is still loading the needed element.",
} as const;

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

const refs = (els: Element[], none: string): Record<string, string> =>
  ({ ...Object.fromEntries(els.map(e => [e.ref, e.line])), none });

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

  async turn(step: string, obs: Observation, recent: string[], attempt = false): Promise<TurnAnswer> {
    const targets = { ...refs(obs.elements, "No element on screen helps accomplish `step`."), ...PAGE_ACTIONS };
    const res = await this.#ask({
      state: { step, ui: obs.text, actions_taken_for_step: recent.length ? recent : "none yet" },
      questions: {
        done: attempt
          ? noul("Given `actions_taken_for_step`, has the user performed every action `step` asks for, regardless of whether the app accepted it?")
          : noul("Given `actions_taken_for_step`, does `ui` show that `step` has been fully accomplished?"),
        target: choice("Which element in `ui` should be interacted with next to accomplish `step`?", targets),
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
    const criteria: Record<string, string> = Object.fromEntries(candidates.map((c, i) => [`v${i}`, c]));
    criteria.none = "None of these values is what `step` asks for.";
    const res = await this.#ask({
      state: { step, ui: obs.text, element: el.line },
      questions: { value: choice("Which value should be entered into `element` to accomplish `step`?", criteria) },
    });
    const a: Pick = res.answers.value;
    // Map label keys back to the values so traces and execution use real text.
    const name = (k: string) => criteria[k] && k !== "none" ? criteria[k] : k;
    return {
      choice: name(a.choice),
      probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([k, p]) => [name(k), p])),
    };
  }

  async assess(step: string, obs: Observation, judged: boolean): Promise<Assessment> {
    const res = await this.#ask({
      state: { check: step, ui: obs.text },
      questions: {
        kind: choice("What kind of check is `check`?", ASSERTION_KINDS),
        subject: choice(
          "Which element in `ui` is the one `check` is about, regardless of whether the check passes?",
          refs(obs.readable, "No element in `ui` is the one `check` is about."),
        ),
        state: choice("Which control state does `check` require?", STATES),
        area: choice(
          "Where does `check` say to look? Pick the element in `ui` that is that area (a list, table, section, dialog...), regardless of whether the check passes.",
          {
            ...Object.fromEntries(obs.areas.map(e => [e.ref, e.line])),
            [AREA_PAGE]: "`check` names no specific area; anywhere on the page counts.",
            [AREA_MISSING]: "`check` names a specific area, but no element in `ui` is that area.",
          },
        ),
        ...(judged ? { judged: noul("Does `ui` satisfy `check`?") } : {}),
      },
    });
    const a = res.answers as typeof res.answers & { judged?: { noul: number } };
    return { kind: a.kind, subject: a.subject, area: a.area, state: a.state, judged: a.judged?.noul };
  }

}

/** Confidence gate: act only on a clear, confident top answer. */
export const GATE_TOP = 0.8;
export function gate(pick: Pick, minTop = GATE_TOP, minMargin = 0.3): boolean {
  const [top = 0, second = 0] = Object.values(pick.probabilities).sort((a, b) => b - a);
  return top >= minTop && top - second >= minMargin;
}
