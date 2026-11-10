// Only the question kinds and state values used by Decisium; no SDK types cross this seam.
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface NoulQuestion {
  type: "noul";
  instructions: string;
}
export type Question = ChoiceQuestion | NoulQuestion;
export const choice = (instructions: string, criteria: Record<string, string>): ChoiceQuestion => ({
  type: "choice",
  instructions,
  criteria,
});
export const noul = (instructions: string): NoulQuestion => ({ type: "noul", instructions });
export interface DecisionRequest<Q extends Record<string, Question> = Record<string, Question>> {
  state: Record<string, string | string[]>;
  questions: Q;
}
type Answer<Q extends Question> = Q extends NoulQuestion
  ? { noul: number }
  : { choice: string; probabilities: Record<string, number> };
export type Answers<Q extends Record<string, Question>> = { [K in keyof Q]: Answer<Q[K]> };
export interface Provenance {
  provider: string;
  requestedModel: string;
  /** Exactly what the API returned, possibly still an alias; not necessarily a pinned version. */
  resolvedModel?: string;
  upstreamProvider?: string;
}
export interface DecisionResponse<Q extends Record<string, Question>> {
  answers: Answers<Q>;
  provenance: Provenance;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
}
export type DecisionMetadata = Omit<DecisionResponse<Record<string, Question>>, "answers">;
export interface DecisionProvider {
  decide<Q extends Record<string, Question>>(
    request: DecisionRequest<Q>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DecisionResponse<Q>>;
}
export type ProviderErrorCode =
  | "authentication"
  | "rate_limit"
  | "unsupported"
  | "transport"
  | "malformed_response"
  | "timeout"
  | "cancelled"
  | "configuration"
  | "request_too_large";
/** Deliberately excludes SDK error bodies, causes and request objects: they can contain credentials. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message = `Decision provider: ${code}`) {
    super(message);
    this.code = code;
    this.name = "ProviderError";
  }
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
export function validateResponse<Q extends Record<string, Question>>(
  request: DecisionRequest<Q>,
  response: unknown,
): Answers<Q> {
  const fail = () => {
    throw new ProviderError("malformed_response");
  };
  if (!object(response) || !object(response.answers)) return fail();
  const answers: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(request.questions)) {
    const a = response.answers[key];
    if (!object(a) || (a.type !== undefined && a.type !== q.type)) return fail();
    if (q.type === "noul") {
      if (!probability(a.noul)) return fail();
      answers[key] = { noul: a.noul };
    } else {
      if (typeof a.choice !== "string" || !Object.hasOwn(q.criteria, a.choice) || !object(a.probabilities))
        return fail();
      const p = a.probabilities;
      if (
        Object.keys(p).length !== Object.keys(q.criteria).length ||
        Object.keys(q.criteria).some((k) => !Object.hasOwn(p, k) || !probability(p[k]))
      )
        return fail();
      if (Math.abs(Object.values(p).reduce<number>((sum, n) => sum + (n as number), 0) - 1) > 0.01) return fail();
      answers[key] = { choice: a.choice, probabilities: { ...p } };
    }
  }
  return answers as Answers<Q>;
}

/** One total deadline, no automatic retries/fallback. The signal reaches the SDK and also bounds a stuck transport. */
export async function providerCall<Q extends Record<string, Question>>(
  request: DecisionRequest<Q>,
  provenance: Provenance,
  call: (signal: AbortSignal) => Promise<{
    answers: unknown;
    model?: string;
    provider?: string;
    usage?: { inputTokens: number | null; outputTokens: number | null } | null;
  }>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DecisionResponse<Q>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new ProviderError("configuration", "Decision timeout must be a positive integer");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let onAbort: () => void = () => {};
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ProviderError(timedOut ? "timeout" : "cancelled"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const res = await Promise.race([aborted, controller.signal.aborted ? aborted : call(controller.signal)]);
    const usage = res.usage ?? null;
    if (usage && [usage.inputTokens, usage.outputTokens].some((n) => n !== null && (!Number.isInteger(n) || n < 0)))
      throw new ProviderError("malformed_response");
    return {
      answers: validateResponse(request, res),
      usage,
      provenance: {
        ...provenance,
        ...(res.model ? { resolvedModel: res.model } : {}),
        ...(res.provider ? { upstreamProvider: res.provider } : {}),
      },
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (controller.signal.aborted) throw new ProviderError(timedOut ? "timeout" : "cancelled");
    const e = object(error) ? error : {};
    if (e.name === "APITimeoutError" || e.name === "RequestTimeoutError") throw new ProviderError("timeout");
    if (e.name === "RequestAbortedError" || e.name === "AbortError") throw new ProviderError("cancelled");
    const status = e.status ?? e.statusCode;
    const code =
      status === 401 || status === 403
        ? "authentication"
        : status === 429
          ? "rate_limit"
          : status === 400 || status === 404 || status === 422
            ? "unsupported"
            : e.name === "SDKValidationError"
              ? "malformed_response"
              : "transport";
    // Preserve the runner's page-size outcome without forwarding an untrusted server message.
    if (
      e.code === "max_tokens_exceeded" ||
      (typeof e.message === "string" && e.message.includes("max_tokens_exceeded"))
    )
      throw new ProviderError("request_too_large", "max_tokens_exceeded");
    throw new ProviderError(code);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
