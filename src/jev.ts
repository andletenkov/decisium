import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Element, Observation } from "./observation.ts";
import { readStep } from "./step.ts";

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
const PAGE_ACTIONS = {
  scroll: "Scroll down: the needed element is not in `ui` yet and may load further down the page.",
  wait: "Wait: `ui` is still loading the needed element.",
} as const;
const ENTER = "Press Enter in the focused field, to submit what was typed (e.g. run a search).";

/**
 * Page actions for this Observation and Step: Enter only while a text field has focus, so it is not offered on every
 * Turn; other keys only when the Step names them ("press Escape"), pressed wherever the focus is (task 0039).
 */
export function pageActions(obs: Observation, step: string): Record<string, string> {
  const out: Record<string, string> = obs.elements.some(e => e.verb === "TYPE" && /\[active\]/.test(e.state)) ? { ...PAGE_ACTIONS, enter: ENTER } : { ...PAGE_ACTIONS };
  for (const key of readStep({ text: step, kind: "action" }).keys) if (key !== "Enter") out[`press ${key}`] = `Press the ${key} key, as \`step\` says.`;
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
  /** The open browser dialog (`obs.dialog`): "accept", "dismiss", or for a prompt one of the Step's quoted values. */
  dialog(step: string, obs: Observation, answers: string[]): Promise<Pick>;
}

/** What answering each kind of browser dialog means, for Jev (task 0040). */
const DIALOG_ANSWERS = {
  accept: {
    confirm: "Click OK: `step` clearly asks for what `dialog` asks to confirm.",
    beforeunload: "Leave the page: `step` clearly intends to leave this page, even if changes are lost.",
  },
  dismiss: {
    confirm: "Click Cancel: `step` does not clearly ask for what `dialog` asks to confirm, or says to cancel.",
    beforeunload: "Stay on the page: `step` does not clearly intend to leave this page.",
    prompt: "Click Cancel: none of the other answers is what `step` asks to enter, or `step` says to cancel.",
  },
} as Record<string, Record<string, string>>;

const refs = (els: Element[]): Record<string, string> => Object.fromEntries(els.map(e => [e.ref, e.line]));

/** Jev API limit: options per choice question. */
const MAX_CHOICES = 255;
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

/**
 * Jev rejects requests over its token limit (`max_tokens_exceeded`): measured between 115k and 117k characters of
 * Wikipedia snapshot in one request. `ui` stays under this budget so 255 choices still fit next to it (task 0021).
 */
export const UI_BUDGET = 80_000;
const SECTION = 8_000; // a page over budget is read in sections of about this size

/**
 * A `ui` over budget, reduced to the sections that matter for `step`. Sections are cut at lines and carry their
 * ancestor lines (so a list item keeps its list); narrow() keeps the likeliest ones per batch until they fit, so every
 * question of the Turn reads one reduced `ui` and their probabilities stay comparable.
 */
export async function reduceUi(ui: string, ask: (sections: Record<string, string>) => Promise<Pick>,
  budget = UI_BUDGET, section = SECTION): Promise<string> {
  if (ui.length <= budget) return ui;
  const lines = ui.split("\n");
  const indent = (l: string) => /^\s*/.exec(l)![0].length;
  const parts: number[][] = [];
  const open: number[] = []; // ancestors of the current line, by indentation
  let part: number[] = [], size = 0;
  lines.forEach((l, i) => {
    while (open.length && indent(lines[open.at(-1)!]) >= indent(l)) open.pop();
    if (size + l.length > section && part.length) {
      parts.push(part);
      part = [...open]; size = open.reduce((n, a) => n + lines[a].length + 1, 0);
    }
    part.push(i); size += l.length + 1;
    open.push(i);
  });
  parts.push(part);
  const text = (p: number[]) => p.map(i => lines[i]).join("\n");
  const kept = await narrow(Object.fromEntries(parts.map((p, i) => [`s${i}`, text(p)])), {}, ask, Math.floor(budget / (section * 1.5)));
  const keep = new Set(Object.keys(kept).flatMap(k => parts[Number(k.slice(1))]));
  return lines.filter((_, i) => keep.has(i)).join("\n");
}

/** Live Jev requests of this process and their tokens; cassette replays cost nothing and are not counted. */
export const jevUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

/** Every question sends the Step text as-is, so a value quoted in a Step (a password included) reaches the API. */
export class JevDecider implements Decider {
  #client?: TypeSafeClient; // created on the first live call: replay-only runs need no TYPESAFE_API_KEY
  #reduced = new WeakMap<Observation, Map<string, Promise<string>>>(); // per Observation and Step: asked once per Turn

  /** `ui` for `step` on this Observation, reduced to the sections that matter when the page is over budget. */
  #ui(obs: Observation, about: "step" | "check", step: string): Promise<string> {
    const byStep = this.#reduced.get(obs) ?? new Map<string, Promise<string>>();
    this.#reduced.set(obs, byStep);
    if (!byStep.has(step)) byStep.set(step, reduceUi(obs.text, async sections => {
      const res = await this.#ask({
        state: { [about]: step, ...sections },
        questions: { pick: choice(`Which of these sections of the page holds what \`${about}\` needs?`,
          Object.fromEntries(Object.keys(sections).map(k => [k, `section \`${k}\``]))) },
      });
      return res.answers.pick;
    }));
    return byStep.get(step)!;
  }

  async #ask<Q extends Parameters<TypeSafeClient["systemOne"]>[0]>(request: Q) {
    const res = await (this.#client ??= new TypeSafeClient({ defaultModel: MODEL })).systemOne(request); // reads TYPESAFE_API_KEY
    jevUsage.calls++;
    jevUsage.inputTokens += res.usage?.input_tokens ?? 0;
    jevUsage.outputTokens += res.usage?.output_tokens ?? 0;
    return { model: res.model, answers: res.answers as Record<string, any> };
  }

  /** One choice question over `criteria`, for narrow(). */
  #choose(state: Record<string, string | string[]>, question: string) {
    return async (criteria: Record<string, string>): Promise<Pick> =>
      (await this.#ask({ state, questions: { pick: choice(question, criteria) } })).answers.pick;
  }

  async turn(step: string, obs: Observation, recent: string[], attempt = false): Promise<TurnAnswer> {
    const state = { step, ui: await this.#ui(obs, "step", step), actions_taken_for_step: recent.length ? recent : "none yet" };
    const question = "Which element in `ui` should be interacted with next to accomplish `step`?";
    const targets = await narrow(refs(obs.elements), { none: "No element on screen helps accomplish `step`.", ...pageActions(obs, step) },
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

  async dialog(step: string, obs: Observation, answers: string[]): Promise<Pick> {
    const { type, message } = obs.dialog!;
    const criteria = Object.fromEntries(answers.map((a, i) => a === "accept" || a === "dismiss"
      ? [a, DIALOG_ANSWERS[a][type]] : [`v${i}`, `Enter "${a}" and click OK.`]));
    const res = await this.#ask({
      state: { step, dialog: message },
      questions: { answer: choice(`A browser ${type === "beforeunload" ? "\"Leave site?\"" : type} dialog is open, saying \`dialog\`. How should it be answered to accomplish \`step\`?`, criteria) },
    });
    const a: Pick = res.answers.answer;
    const name = (k: string) => /^v\d+$/.test(k) ? answers[Number(k.slice(1))] : k;
    return { choice: name(a.choice), probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([k, p]) => [name(k), p])) };
  }

  async value(step: string, obs: Observation, el: Element, candidates: string[]): Promise<Pick> {
    const state = { step, ui: await this.#ui(obs, "step", step), element: el.line };
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
    const state = { check: step, ui: await this.#ui(obs, "check", step) };
    const subjectQ = "Which element in `ui` is the one `check` is about, regardless of whether the check passes?";
    const areaQ = "Where does `check` say to look? Pick the element in `ui` that is that area (a list, table, section, dialog...), regardless of whether the check passes.";
    const [subjects, areas] = await Promise.all([
      narrow(refs(obs.readable), { none: "No element in `ui` is the one `check` is about." }, this.#choose(state, subjectQ)),
      narrow(refs(obs.areas), {
        [AREA_PAGE]: "`check` names no specific area; anywhere on the page counts.",
        [AREA_MISSING]: "`check` names a specific area, but no element in `ui` is that area.",
      }, this.#choose(state, areaQ)),
    ]);
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
