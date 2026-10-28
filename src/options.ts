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
  reportDir: "REPORT_DIR",
  checkTimeout: "CHECK_TIMEOUT",
  actionTimeout: "ACTION_TIMEOUT",
  maxTurns: "MAX_TURNS",
  "confidence.target": "CONFIDENCE_TARGET",
  "confidence.answer": "CONFIDENCE_ANSWER",
} as const;
const TEXT = ["url", "record", "reportDir"];
const BOOL = ["headed", "judged", "strict", "verbose", "debug", "agentReport"];

/** Tuning values (issue 16): defaults, overridden by DECISIUM_* env (filled from worldParameters.decisium). */
export const DEFAULTS = {
  reportDir: "runs",
  confidence: { target: 0.5, answer: 0.8 },
  checkTimeout: 5000,
  actionTimeout: 5000,
  maxTurns: 8,
};
export type Settings = typeof DEFAULTS;

/** The effective tuning values from DECISIUM_* env. Throws on a value out of range. */
export function settings(env: Record<string, string | undefined> = process.env): Settings {
  const num = (key: keyof typeof ENV, fallback: number, ok: (n: number) => boolean, what: string) => {
    const raw = env[`DECISIUM_${ENV[key]}`];
    if (!raw) return fallback;
    const n = Number(raw);
    if (!ok(n)) throw new Error(`${key} must be ${what}, got ${JSON.stringify(raw)}`);
    return n;
  };
  const prob = (n: number) => n > 0 && n <= 1;
  const ms = (n: number) => Number.isInteger(n) && n > 0;
  return {
    reportDir: env.DECISIUM_REPORT_DIR || DEFAULTS.reportDir,
    confidence: {
      target: num("confidence.target", DEFAULTS.confidence.target, prob, "a number in (0, 1]"),
      answer: num("confidence.answer", DEFAULTS.confidence.answer, prob, "a number in (0, 1]"),
    },
    checkTimeout: num("checkTimeout", DEFAULTS.checkTimeout, ms, "a positive whole number of ms"),
    actionTimeout: num("actionTimeout", DEFAULTS.actionTimeout, ms, "a positive whole number of ms"),
    maxTurns: num(
      "maxTurns",
      DEFAULTS.maxTurns,
      (n) => Number.isInteger(n) && n >= 1 && n <= 20,
      "a whole number 1-20",
    ),
  };
}

/** Warnings for settings that let a wrong reading pass; print once per run. */
export function settingWarnings(s: Settings): string[] {
  const { answer } = s.confidence;
  return answer < DEFAULTS.confidence.answer
    ? [
        `Warning: confidence.answer ${answer} is below the default ${DEFAULTS.confidence.answer}: checks, typed values and dialog answers will accept less certain answers, so a wrong reading can pass. Prefer rewording the Step.`,
      ]
    : [];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Fills each DECISIUM_* variable that is not set from `worldParameters.decisium`, then validates the result.
 * Throws on an unknown key, a wrong type or a value out of range. Returns the effective settings.
 */
export function applyOptions(params: unknown, env: Record<string, string | undefined> = process.env): Settings {
  if (params !== undefined && !isObject(params)) throw new Error("worldParameters.decisium must be an object");
  const { confidence, ...rest } = (params ?? {}) as Record<string, unknown>;
  if (confidence !== undefined && !isObject(confidence))
    throw new Error("worldParameters.decisium.confidence must be an object (target, answer)");
  const flat = {
    ...rest,
    ...Object.fromEntries(Object.entries(confidence ?? {}).map(([k, v]) => [`confidence.${k}`, v])),
  };
  for (const [key, value] of Object.entries(flat)) {
    const name = ENV[key as keyof typeof ENV];
    if (!name) throw new Error(`worldParameters.decisium.${key} is not an option (${Object.keys(ENV).join(", ")})`);
    const type = TEXT.includes(key) ? "string" : BOOL.includes(key) ? "boolean" : "number";
    if (typeof value !== type || (type === "string" && !value))
      throw new Error(`worldParameters.decisium.${key} must be a ${type === "string" ? "non-empty string" : type}`);
    if (env[`DECISIUM_${name}`]) continue; // env (or a flag) wins
    env[`DECISIUM_${name}`] = type !== "boolean" ? String(value) : (key === "agentReport" ? !value : value) ? "1" : "0";
  }
  return settings(env);
}

/**
 * Whether our console formatter takes stdout. Only one formatter may write there: a format entry with no path claims it,
 * else cucumber's default `progress` would. `stdout` is cucumber's resolved stdout formatter.
 */
export const ourStdout = (format: unknown[], stdout: string) => stdout === "progress" && !format.includes("progress");
