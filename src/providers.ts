import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  type DecisionProvider,
  type DecisionRequest,
  type Question,
  ProviderError,
  providerCall,
} from "./decision-provider.ts";
import { settings, TYPESAFE_MODEL, OPENROUTER_MODEL } from "./options.ts";
export { TYPESAFE_MODEL, OPENROUTER_MODEL } from "./options.ts";
export const OPENROUTER_MISSING =
  "OpenRouter provider requires @openrouter/sdk. Install it with: npm install @openrouter/sdk";
/** Credentials are environment-only. Never fall back to a different provider\'s key. */
export const credentialName = (provider: string, env: Record<string, string | undefined> = process.env) =>
  env.DECISIUM_MODEL_API_KEY !== undefined
    ? "DECISIUM_MODEL_API_KEY"
    : provider === "openrouter"
      ? "OPENROUTER_API_KEY"
      : "TYPESAFE_API_KEY";
type Options = { signal?: AbortSignal; timeoutMs?: number };

export class TypeSafeProvider implements DecisionProvider {
  #client: TypeSafeClient;
  private model: string;
  constructor(model = TYPESAFE_MODEL, apiKey = process.env[credentialName("typesafe")], fetcher?: typeof fetch) {
    this.model = model;
    if (!apiKey) throw new ProviderError("authentication", `${credentialName("typesafe")} is not set.`);
    this.#client = new TypeSafeClient({
      apiKey,
      defaultModel: model,
      logLevel: "off",
      ...(fetcher ? { fetch: fetcher } : {}),
    });
  }
  decide<Q extends Record<string, Question>>(request: DecisionRequest<Q>, options?: Options) {
    return providerCall(
      request,
      { provider: "typesafe", requestedModel: this.model },
      async (signal) => {
        const res = await this.#client.systemOne(
          { ...request, model: this.model },
          { signal, timeout: options?.timeoutMs ?? 10_000, retry: { maxRetries: 0 } },
        );
        return {
          answers: res.answers,
          model: res.model,
          usage: res.usage ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } : null,
        };
      },
      options,
    );
  }
}

export class OpenRouterProvider implements DecisionProvider {
  private model: string;
  private apiKey?: string;
  private fetcher?: typeof fetch;
  constructor(model = OPENROUTER_MODEL, apiKey = process.env[credentialName("openrouter")], fetcher?: typeof fetch) {
    this.model = model;
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }
  decide<Q extends Record<string, Question>>(request: DecisionRequest<Q>, options?: Options) {
    return providerCall(
      request,
      { provider: "openrouter", requestedModel: this.model },
      async (signal) => {
        // A runtime import is essential: a default install and replay must work without the optional peer.
        const { OpenRouter, HTTPClient } = await import("@openrouter/sdk").catch(() => {
          throw new ProviderError("configuration", OPENROUTER_MISSING);
        });
        signal.throwIfAborted();
        if (!this.apiKey) throw new ProviderError("authentication", `${credentialName("openrouter")} is not set.`);
        const client = new OpenRouter({
          apiKey: this.apiKey,
          // OPENROUTER_DEBUG otherwise logs Authorization headers to the captured run log.
          debugLogger: { group() {}, groupEnd() {}, log() {} },
          ...(this.fetcher ? { httpClient: new HTTPClient({ fetcher: this.fetcher }) } : {}),
        });
        const res = await client.alpha.decisions.create(
          { decisionsRequest: { ...request, model: this.model } },
          { signal, timeoutMs: options?.timeoutMs ?? 10_000, retries: { strategy: "none" } },
        );
        return {
          answers: res.answers,
          model: res.model,
          provider: res.provider,
          usage: res.usage ? { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens } : null,
        };
      },
      options,
    );
  }
}

/** Called only on the first live decision, not when constructing a replay decider. */
export function createProvider(): DecisionProvider {
  const { provider, model } = settings();
  return provider === "typesafe" ? new TypeSafeProvider(model) : new OpenRouterProvider(model);
}
