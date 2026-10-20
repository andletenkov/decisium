// Gherkin `.feature` files -> runnable Scenarios. The official parser expands Background steps and Scenario
// Outline rows ("pickles"), so the runner only sees flat Step lists.
import { AstBuilder, compile, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { IdGenerator, PickleStepType } from "@cucumber/messages";

export type StepKind = "action" | "attempt" | "assertion";

export interface ParsedStep {
  text: string;
  kind: StepKind;
  line?: number; // line in the .feature file, for error reports
}

export interface Scenario {
  name: string;
  url?: string; // from the last `@url:<url>` tag (scenario tags override feature tags)
  steps: ParsedStep[];
}

/** "try"/"attempt" right after the keyword marks an Attempt step: done once performed, even if the app rejects it. */
const ATTEMPT = /^(I\s+)?(try|tries|attempt|attempts)\b/i;

/** Parses a `.feature` source. Throws on Gherkin syntax errors and on step arguments we cannot honour yet. */
export function parseFeature(source: string, uri = "test.feature"): Scenario[] {
  const newId = IdGenerator.uuid();
  const doc = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher()).parse(source);
  const pickles = compile(doc, uri, newId);
  // Gherkin reads keyword-less lines before the first step as a description, so a typo can leave no steps at all.
  const empty = pickles.find(p => !p.steps.length);
  if (empty) throw new Error(`Scenario "${empty.name}" has no steps (lines without Given/When/Then/And/But are read as description)`);
  if (!pickles.length) throw new Error("No scenarios found");
  // Step AST id -> line. Steps live in Background/Scenario, possibly nested in a Rule.
  const lines = new Map<string, number>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { id?: string; keyword?: string; text?: string; location?: { line: number } };
    if (n.id && n.text !== undefined && n.location) lines.set(n.id, n.location.line);
    for (const v of Object.values(node)) walk(v);
  };
  walk(doc.feature);
  return pickles.map(pickle => ({
    name: pickle.name,
    url: pickle.tags.map(t => /^@url:(.+)$/.exec(t.name)?.[1]).filter(Boolean).at(-1),
    steps: pickle.steps.map(step => {
      // Ignoring an attached table/doc string would silently run a different test than the one written.
      if (step.argument) throw new Error(`Step "${step.text}" has a data table or doc string; not supported yet`);
      const kind: StepKind = step.type === PickleStepType.OUTCOME ? "assertion" : ATTEMPT.test(step.text) ? "attempt" : "action";
      return { text: step.text, kind, line: lines.get(step.astNodeIds[0]) };
    }),
  }));
}

/** One Step given on the command line, e.g. `Then the status should be "Draft"`; no keyword means `When`. */
export function parseStep(line: string): ParsedStep {
  const text = /^(Given|When|Then|And|But|\*)\s/i.test(line) ? line : `When ${line}`;
  const [scenario] = parseFeature(`Feature: f\n  Scenario: s\n    ${text}\n`);
  return scenario.steps[0];
}
