# CI

Record locally, commit the cassettes, replay in CI with `--record none`: no API key, no model calls, the same result
every run.

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
      - run: npm ci
      - run: npx decisium install --with-deps
      - run: npx decisium run features/*.feature --record none --parallel auto --format junit:reports/junit.xml
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: decisium-runs, path: runs/ }
```

`runs/` holds the screenshots, Playwright trace and `report.md` of every failed scenario.

## When the UI changes

CI fails as `UI_CHANGED`. If the change is intended, re-record locally and commit the cassette:

```sh
decisium run features/campaign.feature --record new
```

Optional, to collapse cassette diffs on GitHub: add `*.cassette.json linguist-generated=true` to `.gitattributes`.

## Pin an ambiguous target

When an action fails as `AMBIGUOUS`, the report lists the candidates, each with a ready pin command. Check the
screenshot, run the right one, replay:

```sh
decisium pin features/campaign.feature:12 2
decisium run features/campaign.feature --record none
```

Works for single-action Steps such as `I click the "Save" button` or `I type "Ada" into the "Name" field`.

## Docker

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/andletenkov/decisium:<version> \
  run features/*.feature --record none
```

Chromium is preinstalled. Use the version that recorded your cassettes; pass `-e TYPESAFE_API_KEY` to record.
