#!/usr/bin/env bash
# Release gate (task 0050): installs the `npm pack` tarball into a fresh project and runs it as a client would.
# With TYPESAFE_API_KEY: doctor, a live run that records the cassette, then replays with the key unset (zero Jev calls).
# Native keys enable each provider; DECISIUM_MODEL_API_KEY enables only DECISIUM_MODEL_PROVIDER (default typesafe).
# Live commands use the generic key alone; replay unsets all keys. Without keys: packaging and fake HTTP contracts.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cd "$root"
npm run build >/dev/null
tarball=$root/$(npm pack --silent | tail -1)
trap 'rm -rf "$tmp" "$tarball"' EXIT

# Only files from "files" (plus package.json/README/LICENSE), and nothing secret-looking.
contents=$(tar -tzf "$tarball")
bad=$(grep -vE '^package/(dist/|skills/|docs/configuration\.md$|package\.json$|README\.md$|LICENSE$)' <<<"$contents" || true)
[ -z "$bad" ] || { echo "unexpected files in tarball:"; echo "$bad"; exit 1; }
! grep -qiE '(^|/)\.env|\.cassette\.json$|\.ts$' <<<"$(grep -v '\.d\.ts$' <<<"$contents")" || { echo "tarball has .env/cassette/.ts files"; exit 1; }

cd "$tmp"
npm init -y >/dev/null
npm install --silent "$tarball"
# Optional peer must not be auto-installed, imported by TypeSafe, or needed by replay.
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
assert.throws(() => import.meta.resolve('@openrouter/sdk'));
const { OpenRouterProvider, OPENROUTER_MISSING, TypeSafeProvider } = await import('./node_modules/decisium/dist/providers.js');
await assert.rejects(new OpenRouterProvider('model', 'key').decide({ state: {}, questions: {} }), { message: OPENROUTER_MISSING });
const hook = registerHooks({ resolve(specifier, context, next) {
  assert.notEqual(specifier, '@openrouter/sdk', 'TypeSafe/replay imported optional SDK');
  return next(specifier, context);
} });
const { ModelDecider } = await import('./node_modules/decisium/dist/model-decider.js');
const { Cassette } = await import('./node_modules/decisium/dist/cassette.js');
writeFileSync('replay.cassette.json', JSON.stringify({ model: 'legacy-model', entries: { step: { intent: { exact: true } } } }));
const saved = new Cassette('replay.cassette.json', 'ignored', 'none');
assert.deepEqual(await saved.step('step', new ModelDecider()).intent('text', true), { exact: true });
const result = await new TypeSafeProvider('jev-1.14.0', 'key', async () => new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { ok: { noul: 1 } } }))).decide({ state: {}, questions: { ok: { type: 'noul', instructions: 'OK?' } } });
assert.equal(result.answers.ok.noul, 1);
hook.deregister();
JS
npm install --silent @openrouter/sdk@1.5.75
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { OpenRouterProvider } from './node_modules/decisium/dist/providers.js';
const result = await new OpenRouterProvider('typesafe/jev-1.14', 'key', async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.14-20261014', answers: { ok: { type: 'noul', noul: 1 } }, usage: { input_tokens: 0, output_tokens: 0 } }), { headers: { 'content-type': 'application/json' } })).decide({ state: {}, questions: { ok: { type: 'noul', instructions: 'OK?' } } });
assert.equal(result.answers.ok.noul, 1);
assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
JS
cp "$root/test/fixtures/campaign-app/index.html" .
cat > sample.feature <<'EOF'
@url:index.html
Feature: Smoke

  Scenario: Set the activation period
    When I set the activation period to 2 weeks
    Then the activation period should be "2 weeks"
EOF
cat > cucumber.mjs <<'EOF'
export default { import: ["node_modules/decisium/dist/steps.js"], format: ["decisium/formatter"], worldParameters: { decisium: { record: "none" } } };
EOF

(npx decisium 2>&1 || true) | grep Usage: >/dev/null
npx decisium install --dry-run | grep -q 'chromium-' # resolves its own Playwright from dist/
if [ -n "${DECISIUM_MODEL_API_KEY:-}${TYPESAFE_API_KEY:-}${OPENROUTER_API_KEY:-}" ]; then
  npx decisium install # the tarball may resolve a newer Playwright than our lockfile
fi
for provider in typesafe openrouter; do
  if [ "${DECISIUM_MODEL_API_KEY+x}" = x ]; then
    [ "$provider" = "${DECISIUM_MODEL_PROVIDER:-typesafe}" ] || continue
    smoke_key=$DECISIUM_MODEL_API_KEY
  elif [ "$provider" = typesafe ]; then
    smoke_key=${TYPESAFE_API_KEY:-}
  else
    smoke_key=${OPENROUTER_API_KEY:-}
  fi
  if [ -z "$smoke_key" ]; then
    echo "$provider key unset: skipping live smoke"
    continue
  fi
  env -u TYPESAFE_API_KEY -u OPENROUTER_API_KEY DECISIUM_MODEL_API_KEY="$smoke_key" npx decisium doctor sample.feature --provider "$provider"
  env -u TYPESAFE_API_KEY -u OPENROUTER_API_KEY DECISIUM_MODEL_API_KEY="$smoke_key" npx decisium run sample.feature --record all --provider "$provider"
  EXPECTED_PROVIDER="$provider" node --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const c = JSON.parse(fs.readFileSync('sample.cassette.json'));
const decisions = Object.values(c.entries).flatMap(e => e.decisions ?? []);
assert(decisions.length);
assert(decisions.every(d => d.provenance.provider === process.env.EXPECTED_PROVIDER && d.provenance.requestedModel === c.model && d.provenance.resolvedModel));
JS
  env -u DECISIUM_MODEL_API_KEY -u TYPESAFE_API_KEY -u OPENROUTER_API_KEY npx decisium run sample.feature --record none --provider "$provider"
  env -u DECISIUM_MODEL_API_KEY -u TYPESAFE_API_KEY -u OPENROUTER_API_KEY DECISIUM_MODEL_PROVIDER="$provider" npx cucumber-js sample.feature
done
echo "pack smoke OK"
