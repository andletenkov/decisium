import assert from "node:assert/strict";
import { test } from "node:test";
import { choice, noul, validateResponse, ProviderError } from "../src/decision-provider.ts";

const request = { state: { step: "test" }, questions: { pick: choice("Pick", { a: "A", b: "B" }), ok: noul("OK?") } };
const response = () => ({ answers: { pick: { choice: "a", probabilities: { a: 0.8, b: 0.2 } }, ok: { noul: 0.9 } } });

test("provider contract preserves distributions and noul, rejects missing or malformed answers", () => {
  assert.deepEqual(validateResponse(request, response()), response().answers);
  for (const answers of [
    {},
    { ...response().answers, ok: { noul: 2 } },
    { ...response().answers, pick: { choice: "a", probabilities: { a: 1 } } },
    { ...response().answers, pick: { choice: "z", probabilities: { a: 0.8, b: 0.2 } } },
  ]) {
    assert.throws(() => validateResponse(request, { answers }), ProviderError);
  }
});
