// Declarative state preconditions (issue 11): `@state-def:<name>` scenarios in `*.state.feature` files are sequences of
// Steps a scenario tagged `@state:<name>` runs before its own. `@save:storage` on a definition saves its cookies and
// localStorage once per run and loads them into later consumers instead of replaying its Steps.
import { AstBuilder, compile, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";
import { globSync, readFileSync } from "node:fs";
import { fromPickle, tagValue, urlFromTags } from "./feature.ts";
import { readStep, type ParsedStep } from "./step.ts";

export interface StateDef {
  name: string;
  file: string;
  line: number; // of the Scenario
  url?: string;
  dep?: string; // `@state:` on the definition: the state it starts from
  save: boolean; // `@save:storage`
  steps: ParsedStep[];
}
export type States = Map<string, StateDef>;

export const STATE_FILE = /\.state\.feature$/;
export const isStateFile = (f: string) => STATE_FILE.test(f);
const SKIP = /(^|[\\/])(node_modules|\.git|dist|build|runs)$/;

/** State definition files: `**\/*.state.feature` under `cwd` (or `glob`), skipping dependency and generated directories. */
export function discoverStates(glob = "**/*.state.feature", cwd = "."): string[] {
  return globSync(glob, { cwd, exclude: (p) => SKIP.test(String(p)) })
    .map((f) => (cwd === "." ? f : `${cwd}/${f}`))
    .sort();
}

/** Decisium's tag names: a colon tag a small edit away from one is a typo, not a team tag (`@stat:` for `@state:`). */
const TAGS = ["url", "viewport", "locale", "timezone", "geolocation", "replay-network", "state", "state-def", "save"];
// One letter dropped, added, or two neighbours swapped. A changed letter is not a typo here: `@stage:`, `@date:` are
// real team tags.
const typo = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) === 1) {
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    return [...l].some((_, i) => l.slice(0, i) + l.slice(i + 1) === s);
  }
  return a.length === b.length && [...a].some((_, i) => a.slice(0, i) + a[i + 1] + a[i] + a.slice(i + 2) === b);
};
/** "did you mean" for a colon tag near a Decisium tag name, else undefined. */
export function nearMiss(tag: string): string | undefined {
  const m = /^@([\w-]+):/.exec(tag);
  if (!m || TAGS.includes(m[1])) return undefined;
  const best = TAGS.find((t) => typo(m[1].toLowerCase(), t));
  return best && `${tag}: unknown tag, did you mean @${best}:?`;
}

/** Definitions in one `*.state.feature` source. Throws on what would run differently than it reads. */
export function parseStates(source: string, uri: string): StateDef[] {
  const newId = IdGenerator.uuid();
  const doc = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher()).parse(source);
  const feature = doc.feature;
  if (!feature) return [];
  const at = (line: number) => `${uri}:${line}`;
  for (const t of feature.tags)
    if (t.name.startsWith("@state-def:") || t.name.startsWith("@state:") || t.name.startsWith("@save:"))
      throw new Error(`${at(t.location.line)}: ${t.name} on a Feature would apply to every scenario; tag the scenario`);
  const children = feature.children.flatMap((c) => (c.rule ? c.rule.children : [c]));
  const bg = children.find((c) => c.background)?.background;
  if (bg) throw new Error(`${at(bg.location.line)}: a Background in a state definition file runs before every state`);
  const scenarios = new Map(children.flatMap((c) => (c.scenario ? [[c.scenario.id, c.scenario] as const] : [])));
  const lines = new Map(children.flatMap((c) => c.scenario?.steps ?? []).map((s) => [s.id, s.location.line] as const));
  const out: StateDef[] = [];
  for (const p of compile(doc, uri, newId)) {
    const sc = scenarios.get(p.astNodeIds[0])!;
    const tags = p.tags.map((t) => t.name);
    for (const t of tags) {
      const near = nearMiss(t);
      if (near) throw new Error(`${at(sc.location.line)}: ${near}`);
    }
    const name = tagValue(p.tags, "state-def");
    if (!name)
      throw new Error(`${at(sc.location.line)}: "${p.name}" in a state definition file has no @state-def:<name>`);
    if (sc.examples.length) throw new Error(`${at(sc.location.line)}: a state definition cannot be a Scenario Outline`);
    if (tags.filter((t) => t.startsWith("@state:")).length > 1)
      throw new Error(`${at(sc.location.line)}: at most one @state: per scenario (chain states instead)`);
    const save = tagValue(p.tags, "save");
    if (save !== undefined && save !== "storage")
      throw new Error(`${at(sc.location.line)}: @save:${save}: only @save:storage is supported`);
    const steps = p.steps.map((s) => ({ ...fromPickle(s), line: lines.get(s.astNodeIds[0]) }));
    if (save && steps.at(-1)?.kind !== "assertion")
      throw new Error(
        `${at(sc.location.line)}: @save:storage state "${name}" must end with a Then check (re-run after loading the saved storage)`,
      );
    out.push({
      name,
      file: uri,
      line: sc.location.line,
      url: urlFromTags(p.tags),
      dep: tagValue(p.tags, "state"),
      save: !!save,
      steps,
    });
  }
  return out;
}

/** Parses and links every definition. Throws on a duplicate name, an unknown dependency or a cycle. */
export function loadStates(files: string[]): States {
  const states: States = new Map();
  for (const file of files)
    for (const def of parseStates(readFileSync(file, "utf8"), file)) {
      const twin = states.get(def.name);
      if (twin)
        throw new Error(`state "${def.name}" is defined twice: ${twin.file}:${twin.line} and ${def.file}:${def.line}`);
      states.set(def.name, def);
    }
  for (const def of states.values()) {
    if (def.dep && !states.has(def.dep))
      throw new Error(`${def.file}:${def.line}: unknown state "${def.dep}" in @state:${def.dep}`);
    stateChain(states, def.name); // cycles
  }
  return states;
}

/** The states `name` runs, dependencies first. Throws on an unknown name or a cycle. */
export function stateChain(states: States, name: string): StateDef[] {
  const chain: StateDef[] = [];
  for (let n: string | undefined = name; n; n = states.get(n)!.dep) {
    const def = states.get(n);
    if (!def) throw new Error(`unknown state "${n}"`);
    if (chain.includes(def))
      throw new Error(
        `state cycle: ${[...chain, def]
          .map((d) => d.name)
          .reverse()
          .join(" -> ")}`,
      );
    chain.push(def);
  }
  return chain.reverse();
}

/**
 * The chain a consumer scenario runs, after checking its tags. `tags`: all its tags (feature ones included); `own`: the
 * scenario's own. Throws on an unknown state, several `@state:`, a feature-level `@state:`, or an own `@url:` with it.
 */
export function consumerChain(
  states: States,
  scenario: { name: string; tags: readonly string[]; own: readonly string[] },
  env: Record<string, string | undefined> = process.env,
): StateDef[] {
  const near = scenario.tags.map(nearMiss).find(Boolean);
  if (near) throw new Error(`"${scenario.name}": ${near}`);
  if (scenario.tags.some((t) => t.startsWith("@state-def:")))
    throw new Error(`"${scenario.name}": @state-def: only works in a *.state.feature file; move the scenario there`);
  const used = scenario.tags.filter((t) => t.startsWith("@state:"));
  if (!used.length) return [];
  if (used.some((t) => !scenario.own.includes(t)))
    throw new Error(`"${scenario.name}": @state: on a Feature is not supported; tag each scenario`);
  if (used.length > 1) throw new Error(`"${scenario.name}": at most one @state: per scenario (chain states instead)`);
  if (scenario.own.some((t) => t.startsWith("@url:")))
    throw new Error(`"${scenario.name}": @url: and @state: together; the state's @url: is where the scenario starts`);
  const chain = stateChain(states, used[0].slice("@state:".length));
  if (!env.DECISIUM_URL && !chain[0].url)
    throw new Error(
      `No start URL for state "${chain[0].name}" (${chain[0].file}:${chain[0].line}): pass --url or add an @url:<url> tag.`,
    );
  if (
    scenario.tags.some((t) => t.startsWith("@replay-network:")) &&
    chain.some((d) => d.steps.some((s) => readStep(s).placeholders.length))
  )
    throw new Error(
      `"${scenario.name}": @replay-network with a state that types secrets would record them into the HAR file`,
    );
  return chain;
}
