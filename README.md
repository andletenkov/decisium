# Decisium

Plain-English Gherkin steps run against a real browser (Playwright) by an AI agent, with record/replay cassettes.

## Install

```sh
npm install --save-dev decisium
npx playwright install chromium
export TYPESAFE_API_KEY=...   # Jev; not needed to replay with --record none
npx decisium doctor my.feature
npx decisium run my.feature
```

`npx decisium` prints the full usage.

## Raw cucumber-js

```js
// cucumber.mjs
export default {
  import: ["node_modules/decisium/dist/steps.js"],
  format: ["decisium/formatter"],
  worldParameters: { decisium: { record: "new" } },
};
```

then `npx cucumber-js my.feature`. Options: [docs/configuration.md](docs/configuration.md).
Writing steps: [docs/cookbook.md](docs/cookbook.md). Agent skill: `skills/decisium/SKILL.md`.
