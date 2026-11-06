import { randomBytes } from "node:crypto";

/** A short, random 96-bit identifier, safe for names and URLs. */
export const newRunId = () => randomBytes(12).toString("base64url");

/** Substitute this run's ID; all other text is left untouched. */
export function fill(text: string, values: Record<string, string>): string {
  const id = values["{{decisium.runId}}"];
  return id === undefined ? text : text.replaceAll("{{decisium.runId}}", () => id);
}
