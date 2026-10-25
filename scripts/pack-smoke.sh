#!/usr/bin/env bash
# Release gate (task 0050): installs the `npm pack` tarball into a fresh project and runs it as a client would.
# With TYPESAFE_API_KEY: doctor, a live run that records the cassette, then replays with the key unset (zero Jev calls).
# Without it (forks, local): only the install and the bin are checked.
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
bad=$(grep -vE '^package/(dist/|skills/|docs/(cookbook|configuration)\.md$|package\.json$|README\.md$|LICENSE$)' <<<"$contents" || true)
[ -z "$bad" ] || { echo "unexpected files in tarball:"; echo "$bad"; exit 1; }
! grep -qiE '(^|/)\.env|\.cassette\.json$|\.ts$' <<<"$(grep -v '\.d\.ts$' <<<"$contents")" || { echo "tarball has .env/cassette/.ts files"; exit 1; }

cd "$tmp"
npm init -y >/dev/null
npm install --silent "$tarball"
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
if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  echo "TYPESAFE_API_KEY unset: skipping doctor and live/replay runs (install and bin checked)"
  exit 0
fi
npx decisium doctor sample.feature
npx decisium run sample.feature --record all
test -f sample.cassette.json
env -u TYPESAFE_API_KEY npx decisium run sample.feature --record none
env -u TYPESAFE_API_KEY npx cucumber-js sample.feature
echo "pack smoke OK"
