import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cassette } from "../src/cassette.ts";
import { choice, noul, validateResponse, ProviderError } from "../src/decision-provider.ts";
import { TypeSafeProvider, OpenRouterProvider, missingCredential } from "../src/providers.ts";
import { settings, applyOptions } from "../src/options.ts";
import { ModelDecider } from "../src/model-decider.ts";
const request = {
  state: { step: "test", recent: ["clicked"] },
  questions: { pick: choice("Pick", { a: "A", b: "B" }), ok: noul("OK?") },
};
const response = () => ({
  answers: {
    pick: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 } },
    ok: { type: "noul", noul: 0.9 },
  },
});
for (const Provider of [TypeSafeProvider, OpenRouterProvider]) {
  const wire = () => ({ ...response(), model: "jev-1.14.0", usage: { input_tokens: 12, output_tokens: 0 } });
  const fetcher =
    (body: unknown, status = 200): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  test(`${Provider.name}: actual SDK preserves typed answers, state, usage and identity`, async () => {
    let sent: Record<string, unknown> = {};
    const fake: typeof fetch = async (input, init) => {
      sent = JSON.parse(input instanceof Request ? await input.text() : String(init?.body));
      return fetcher(wire())(input, init);
    };
    const result = await new Provider("jev-latest", "test-secret", fake).decide(request);
    assert.deepEqual(result.answers, validateResponse(request, response()));
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 0 });
    assert.equal(result.provenance.requestedModel, "jev-latest");
    assert.equal(result.provenance.resolvedModel, "jev-1.14.0");
    assert.deepEqual(sent.state, request.state);
    assert.deepEqual(sent.questions, request.questions);
    assert.equal(JSON.stringify(result).includes("test-secret"), false);
  });
  test(`${Provider.name}: generic key wins, native key is selected-provider-only`, async () => {
    const native = Provider === TypeSafeProvider ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";
    const other = Provider === TypeSafeProvider ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
    const names = ["DECISIUM_MODEL_API_KEY", native, other];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    let authorization: string | null = null;
    const fake: typeof fetch = async (input, init) => {
      authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(
        "authorization",
      );
      return fetcher(wire())(input, init);
    };
    try {
      process.env.DECISIUM_MODEL_API_KEY = "generic-secret";
      process.env[native] = "native-secret";
      process.env[other] = "other-secret";
      const result = await new Provider("model", undefined, fake).decide(request);
      assert.equal(authorization, "Bearer generic-secret");
      assert.doesNotMatch(JSON.stringify(result), /generic-secret|native-secret|other-secret/);
      delete process.env[native];
      await new Provider("model", undefined, fake).decide(request);
      assert.equal(authorization, "Bearer generic-secret");
      process.env[native] = "native-secret";
      process.env.DECISIUM_MODEL_API_KEY = "";
      authorization = null;
      await assert.rejects(
        async () => new Provider("model", undefined, fake).decide(request),
        (e: unknown) => e instanceof ProviderError && e.code === "authentication",
      );
      assert.equal(authorization, null);
      delete process.env.DECISIUM_MODEL_API_KEY;
      await new Provider("model", undefined, fake).decide(request);
      assert.equal(authorization, "Bearer native-secret");
      delete process.env[native];
      authorization = null;
      await assert.rejects(
        async () => new Provider("model", undefined, fake).decide(request),
        (e: unknown) => e instanceof ProviderError && e.code === "authentication",
      );
      assert.equal(authorization, null);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
  test(`${Provider.name}: SDK debug environment cannot log credentials`, async (t) => {
    const log = t.mock.method(console, "log", () => {});
    const group = t.mock.method(console, "group", () => {});
    const end = t.mock.method(console, "groupEnd", () => {});
    const old = process.env.OPENROUTER_DEBUG;
    process.env.OPENROUTER_DEBUG = "1";
    try {
      await new Provider("model", "secret", fetcher(wire())).decide(request);
      assert.equal(log.mock.callCount() + group.mock.callCount() + end.mock.callCount(), 0);
    } finally {
      if (old === undefined) delete process.env.OPENROUTER_DEBUG;
      else process.env.OPENROUTER_DEBUG = old;
    }
  });
  test(`${Provider.name}: malformed answers fail, never become fabricated probabilities`, async () => {
    for (const answers of [
      {},
      { ...response().answers, ok: { type: "noul", noul: -1 } },
      { ...response().answers, pick: { type: "choice", choice: "a" } },
    ]) {
      await assert.rejects(
        new Provider("model", "key", fetcher({ ...wire(), answers })).decide(request),
        (e: unknown) => e instanceof ProviderError && e.code === "malformed_response",
      );
    }
  });
  test(`${Provider.name}: errors are normalized and never expose SDK payloads`, async () => {
    for (const [status, code] of [
      [401, "authentication"],
      [403, "authentication"],
      [429, "rate_limit"],
      [400, "unsupported"],
      [503, "transport"],
    ] as const) {
      await assert.rejects(
        new Provider("model", "secret", fetcher({ error: { message: "secret", code: status } }, status)).decide(
          request,
        ),
        (e: unknown) =>
          e instanceof ProviderError &&
          e.code === code &&
          !JSON.stringify(e).includes("secret") &&
          !e.stack?.includes("secret"),
      );
    }
  });
  test(`${Provider.name}: transport exceptions are sanitized`, async () => {
    await assert.rejects(
      new Provider("model", "secret", async () => {
        throw new Error("secret");
      }).decide(request),
      (e: unknown) => e instanceof ProviderError && e.code === "transport" && !e.stack?.includes("secret"),
    );
  });
  test(`${Provider.name}: pre-cancellation, in-flight cancellation and total timeout`, async () => {
    let calls = 0;
    let signal: AbortSignal | null | undefined;
    const stuck: typeof fetch = async (input, init) => {
      calls++;
      signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }),
      );
    };
    const provider = new Provider("model", "key", stuck);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      provider.decide(request, { signal: cancelled.signal }),
      (e: unknown) => e instanceof ProviderError && e.code === "cancelled",
    );
    assert.equal(calls, 0);
    await assert.rejects(
      provider.decide(request, { timeoutMs: 50 }),
      (e: unknown) => e instanceof ProviderError && e.code === "timeout",
    );
    assert.equal(signal?.aborted, true);
    const controller = new AbortController();
    const pending = provider.decide(request, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (e: unknown) => e instanceof ProviderError && e.code === "cancelled");
    assert.equal(signal?.aborted, true);
  });
}

test("TypeSafe unavailable usage is not measured zero; returned aliases stay aliases", async () => {
  const provider = new TypeSafeProvider(
    "jev-latest",
    "key",
    async () =>
      new Response(JSON.stringify({ ...response(), model: "jev-latest" }), {
        headers: { "content-type": "application/json" },
      }),
  );
  const result = await provider.decide(request);
  assert.equal(result.usage, null);
  assert.equal(result.provenance.resolvedModel, "jev-latest");
});

test("TypeSafe preserves partial token usage rather than dropping measured counts", async () => {
  const provider = new TypeSafeProvider(
    "model",
    "key",
    async () =>
      new Response(JSON.stringify({ ...response(), model: "model", usage: { input_tokens: 7, output_tokens: null } })),
  );
  assert.deepEqual((await provider.decide(request)).usage, { inputTokens: 7, outputTokens: null });
});

test("missing key message names the empty generic key instead of calling it unset", () => {
  assert.equal(
    missingCredential("typesafe", { DECISIUM_MODEL_API_KEY: "", TYPESAFE_API_KEY: "k" }),
    "DECISIUM_MODEL_API_KEY is empty; remove it to use the provider's own key.",
  );
  assert.equal(missingCredential("openrouter", {}), "OPENROUTER_API_KEY is not set.");
});

test("provider configuration follows env > world options > defaults", () => {
  assert.equal(settings({}).model, "jev-1.14.0");
  assert.equal(settings({ DECISIUM_MODEL_PROVIDER: "openrouter" }).model, "typesafe/jev-1.14");
  assert.equal(applyOptions({ provider: "openrouter", model: "alias", decisionTimeout: 99 }, {}).model, "alias");
  assert.equal(applyOptions({ provider: "openrouter" }, { DECISIUM_MODEL_PROVIDER: "typesafe" }).provider, "typesafe");
  assert.throws(() => settings({ DECISIUM_MODEL_PROVIDER: "chat" }));
  assert.throws(() => applyOptions({ modelApiKey: "secret" }, {}), /is not an option/);
  assert.throws(() => applyOptions({ apiKey: "secret" }, {}), /is not an option/);
  const env: Record<string, string | undefined> = {};
  applyOptions({ provider: "openrouter" }, env);
  assert.equal(env.DECISIUM_MODEL_PROVIDER, "openrouter");
  assert.equal(env.DECISIUM_PROVIDER, undefined);
  assert.throws(() => settings({ DECISIUM_MODEL: " " }));
  assert.throws(() => settings({ DECISIUM_DECISION_TIMEOUT: "0" }));
});

test("shared model-decider accepts an injected provider without live setup", async () => {
  const decider = new ModelDecider({
    async decide(req) {
      return {
        answers: validateResponse(req, {
          answers: Object.fromEntries(
            Object.entries(req.questions).map(([key, q]) => [
              key,
              q.type === "noul"
                ? { noul: 1 }
                : {
                    choice: Object.keys(q.criteria)[0],
                    probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 1 : 0])),
                  },
            ]),
          ),
        }),
        usage: null,
        provenance: { provider: "test", requestedModel: "custom" },
      };
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "decisium-provider-"));
  try {
    const path = join(dir, "test.cassette.json");
    const cassette = new Cassette(path, "custom", "all");
    const entry = cassette.step("step", decider);
    const intent = await entry.intent?.("I click Save", false);
    entry.done(true);
    cassette.save();
    assert.equal(decider.decisions[0].provenance.provider, "test");
    assert.equal(decider.decisions[0].usage, null);
    const recorded = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(recorded).entries.step.decisions, decider.decisions);
    const replay = new Cassette(path, "different-provider-model", "none").step("step", new ModelDecider());
    assert.deepEqual(await replay.intent?.("I click Save", false), intent);
    replay.done(true);
    assert.equal(readFileSync(path, "utf8"), recorded);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
