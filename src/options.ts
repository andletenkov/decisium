// Decisium's run options (task 0049): `worldParameters: { decisium: {...} }` in the cucumber configuration, so raw
// `npx cucumber-js` reads them too; DECISIUM_* env (which `decisium run` flags set) overrides them. The merged values
// are written back to DECISIUM_* env, which the hooks and the console formatter read.

const ENV = {
  url: "URL",
  record: "RECORD",
  headed: "HEADED",
  judged: "JUDGED",
  strict: "STRICT",
  verbose: "VERBOSE",
  debug: "DEBUG",
  agentReport: "NO_AGENT_REPORT",
} as const;

/** Fills each DECISIUM_* variable that is not set from `worldParameters.decisium`. Throws on an unknown key or a wrong type. */
export function applyOptions(params: unknown, env: Record<string, string | undefined> = process.env) {
  if (params === undefined) return;
  if (typeof params !== "object" || params === null || Array.isArray(params))
    throw new Error("worldParameters.decisium must be an object");
  for (const [key, value] of Object.entries(params)) {
    const name = ENV[key as keyof typeof ENV];
    if (!name) throw new Error(`worldParameters.decisium.${key} is not an option (${Object.keys(ENV).join(", ")})`);
    const text = key === "url" || key === "record";
    if (typeof value !== (text ? "string" : "boolean"))
      throw new Error(`worldParameters.decisium.${key} must be a ${text ? "string" : "boolean"}`);
    if (env[`DECISIUM_${name}`]) continue; // env (or a flag) wins
    env[`DECISIUM_${name}`] = text ? (value as string) : (key === "agentReport" ? !value : value) ? "1" : "0";
  }
}

/**
 * Whether our console formatter takes stdout. Only one formatter may write there: a format entry with no path claims it,
 * else cucumber's default `progress` would. `stdout` is cucumber's resolved stdout formatter.
 */
export const ourStdout = (format: unknown[], stdout: string) => stdout === "progress" && !format.includes("progress");
