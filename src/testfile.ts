export interface ParsedStep {
  text: string;
  assertion: boolean;
}

export interface TestFile {
  name?: string;
  url?: string;
  steps: ParsedStep[];
}

const KEYWORD = /^(Given|When|Then|And|But)\s+/i;

/** `Test:`/`URL:` headers, one Step per line, `#` comments. `Then` (and `And`/`But` after it) marks an Assertion step. */
export function parseTestFile(src: string): TestFile {
  const file: TestFile = { steps: [] };
  let inThen = false;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^(Test|URL):\s*(.*)$/i.exec(line);
    if (header) {
      if (header[1].toLowerCase() === "test") file.name = header[2];
      else file.url = header[2];
      continue;
    }
    const kw = KEYWORD.exec(line)?.[1].toLowerCase();
    if (kw === "then") inThen = true;
    else if (kw !== "and" && kw !== "but") inThen = false;
    file.steps.push({ text: line.replace(KEYWORD, ""), assertion: inThen });
  }
  return file;
}
