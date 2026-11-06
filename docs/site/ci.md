# CI

Replay committed cassettes: no model calls, no API key, the same outcome every run.

```yaml
# .github/workflows/e2e.yml
name: e2e
on: [push, pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci # decisium in devDependencies: replays with the version that recorded
      - run: npx decisium install --with-deps
      - run: npx decisium run features/*.feature --record none --parallel auto --format junit:reports/junit.xml
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: decisium-runs, path: runs/ }
```

With a global install instead, replace `npm ci` with `npm install -g decisium@0.1.4` (the version that recorded the
cassettes) and drop `npx`.

Upload `runs/` (or your `reportDir`) on failure: it holds the screenshots, Playwright trace and `report.md` for every failed scenario.

## Docker image

Every release is published as `ghcr.io/andletenkov/decisium:<version>` (also `:<major>.<minor>`), for amd64 and arm64.
Chromium and its system libraries are already installed, so `decisium install` is not needed. The image's entrypoint is
`decisium`, and its working directory is `/work`:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/andletenkov/decisium:0.1.5 \
  run features/*.feature --record none --format junit:reports/junit.xml
```

Use the image version that recorded your cassettes.

To record cassettes or heal Steps, pass the key: `-e TYPESAFE_API_KEY`. Any runner that can start a container (a
Kubernetes Job, a test orchestrator, a CI service) runs features the same way: mount or check out the project into the
working directory and collect `reports/` and `runs/` as artifacts.
