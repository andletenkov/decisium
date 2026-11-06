/** Substitute this run's ID; all other text is left untouched. */
export function fill(text: string, values: Record<string, string>): string {
  const id = values["{{runId}}"];
  return id === undefined ? text : text.replaceAll("{{runId}}", () => id);
}
