# Decisium

Semantic UI testing with decision models. Plain-English Gherkin Steps run in a real browser (Playwright): Jev, a decision
model, picks among the actions the page actually offers, and code decides pass/fail. No selectors, no LLM, no prompts.
Record/replay cassettes make CI deterministic with zero model calls.

**Requires Jev:** live runs call TypeSafe's Jev model through its API (`TYPESAFE_API_KEY`). Replays (`--record none`)
make no calls and need no key. Decisium's code is MIT; Jev is TypeSafe's hosted service under its own terms.

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
