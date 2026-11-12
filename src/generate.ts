import { randomBytes } from "node:crypto";

/** A short, random 96-bit identifier, safe for names and URLs. */
export const newRunId = () => randomBytes(12).toString("base64url");

/** Substitute this run's ID; all other text is left untouched. */
export function fill(text: string, values: Record<string, string>): string {
  const id = values["{{decisium.runId}}"];
  return id === undefined ? text : text.replaceAll("{{decisium.runId}}", () => id);
}

/**
 * The run's ID as an app may show it: in any case, its "-" and "_" kept, collapsed or dropped (a slug derived from a
 * name that holds it; issue #90, problem 3). Separators around it are part of the match: whether the ID starts with
 * "-" must not change the text around it.
 */
export function runIdPattern(id: string): RegExp {
  return new RegExp(`[-_]*${[...id.replace(/[-_]/g, "")].join("[-_]*")}[-_]*`, "gi");
}
