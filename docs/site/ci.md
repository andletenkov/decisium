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

Upload `runs/` on failure: it holds the screenshots, Playwright trace and `report.md` for every failed scenario.
