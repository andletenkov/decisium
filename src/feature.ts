// Gherkin `.feature` files -> runnable Scenarios. The official parser expands Background steps and Scenario
// Outline rows ("pickles"), so the runner only sees flat Step lists.
import { AstBuilder, compile, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { IdGenerator, type PickleStepArgument } from "@cucumber/messages";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stepKind, type ParsedStep, type StepArgument } from "./step.ts";

export interface Scenario {
  name: string;
  tags: string[];
  url?: string; // from the last `@url:<url>` tag (scenario tags override feature tags)
  steps: ParsedStep[];
}

/** Start URL from the last `@url:<url>` tag (pickle tags list feature tags first). */
export const urlFromTags = (tags: readonly { name: string }[]) =>
  tags.map(t => /^@url:(.+)$/.exec(t.name)?.[1]).filter(Boolean).at(-1);

/** A pickle step's data table or doc string, only the one it has. */
export const stepArgument = ({ argument }: { argument?: PickleStepArgument }): StepArgument =>
  argument?.dataTable ? { table: argument.dataTable.rows.map(r => r.cells.map(c => c.value)) }
  : argument?.docString ? { docString: argument.docString.content } : {};

/** Parses a `.feature` source. Throws on Gherkin syntax errors. */
export function parseFeature(source: string, uri = "test.feature"): Scenario[] {
  const newId = IdGenerator.uuid();
  const doc = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher()).parse(source);
  const pickles = compile(doc, uri, newId);
  // Gherkin reads keyword-less lines before the first step as a description, so a typo can leave no steps at all.
  const empty = pickles.find(p => !p.steps.length);
  if (empty) throw new Error(`Scenario "${empty.name}" has no steps (lines without Given/When/Then/And/But are read as description)`);
  if (!pickles.length) throw new Error("No scenarios found");
  const lines = new Map((doc.feature?.children ?? []).flatMap(c => c.rule ? c.rule.children : [c])
    .flatMap(c => (c.background ?? c.scenario)?.steps ?? []).map(s => [s.id, s.location.line]));
  // An action table's rows become quoted values (readStep().rows): an empty cell gives none, a `"` splits one in two.
  for (const p of pickles) for (const s of p.steps) {
    const cell = stepKind(s) !== "assertion" && s.argument?.dataTable?.rows.flatMap(r => r.cells).find(c => !c.value.trim() || /["“”]/.test(c.value));
    if (cell) throw new Error(`Line ${lines.get(s.astNodeIds[0])}: an action's table cannot have ${cell.value.trim() ? `a cell with a double quote (${cell.value})` : "an empty cell"}; it becomes a quoted value`);
  }
  return pickles.map(pickle => ({
    name: pickle.name,
    tags: pickle.tags.map(t => t.name),
    url: urlFromTags(pickle.tags),
    steps: pickle.steps.map(step => ({ text: step.text, kind: stepKind(step), line: lines.get(step.astNodeIds[0]), ...stepArgument(step) })),
  }));
}

/** One Step given on the command line, e.g. `Then the status should be "Draft"`; no keyword means `When`. */
export function parseStep(line: string): ParsedStep {
  return parseFeature(stepFeature(line))[0].steps[0];
}

/** A one-Step `.feature` source, so `decisium step` runs through the same runner as files. */
export function stepFeature(line: string): string {
  const text = /^(Given|When|Then|And|But|\*)\s/i.test(line) ? line : `When ${line}`;
  return `Feature: step\n  Scenario: step\n    ${text}\n`;
}

// Local paths keep their ?query (e.g. index.html?decoy=1) instead of having it encoded into the file name.
export const toUrl = (u: string) => {
  if (/^[a-z]+:\/\//i.test(u)) return u;
  const [path, query] = u.split(/(?=\?)/);
  return pathToFileURL(resolve(path)).href + (query ?? "");
};
