# Advanced

## Browser context

Tags on a feature or scenario set up its browser.

```gherkin
@url:https://shop.example.com @locale:de-DE @timezone:Europe/Berlin
Feature: Shop in German

  @viewport:iPhone-13 @geolocation:52.52,13.40
  Scenario: Checkout on a phone
    When I add the "Backpack" to the cart
    Then the cart badge should show "1"
```

`@viewport:` takes `390x844` or a Playwright device name (dashes for spaces). A scenario's tag wins over the feature's.

## Client steps

Your own cucumber step definitions run next to Decisium: a line they match runs your code, every other line goes to
Jev. Use them for setup the page cannot do (mocks, cookies, API login).

```ts
// steps/campaigns.steps.ts
import { Given } from "@cucumber/cucumber";

Given("the campaigns API returns {string}", async function (name: string) {
  await this.context.route("**/api/campaigns", (route) => route.fulfill({ json: [{ id: 1, name }] }));
});
```

```sh
decisium run features/campaigns.feature --import steps/campaigns.steps.ts
```

`this.page` is the current Playwright `Page`, `this.context` the `BrowserContext`. Client steps call no model and are
not recorded.

## States

A reusable precondition, defined once in a `*.state.feature` file and used with `@state:`.

```gherkin
# features/shop.state.feature
@url:https://shop.example.com
Feature: Shop states

  @state-def:logged-in @save:storage
  Scenario: Logged in
    When I log in as "$USERNAME" with password "$PASSWORD"
    Then the header should show "Admin"
```

```gherkin
@state:logged-in
Scenario: Checkout shows the total
  When I open the checkout
  Then the order total should be "59.97"
```

`@save:storage` logs in once per run and reuses the cookies and `localStorage`. States can chain
(`@state-def:cart @state:logged-in`). A failing state is a setup error, not a test failure.

## Network replay

`@replay-network:<glob>` records matching browser requests and replays them, for a slow, costly or unstable backend
(an app that calls an LLM).

```gherkin
@replay-network:**/api/**
Scenario: The assistant answers
  When I ask the assistant "What is my balance?"
  Then the answer should mention "balance"
```

It follows `--record` like the cassette and is saved to `<feature>.network/<scenario>.har`; commit it. WebSockets are
not recorded.

## Running with cucumber-js

`decisium run` already runs inside cucumber-js. To run Decisium Steps from plain `npx cucumber-js` (per-project
install only):

```js
// cucumber.mjs
export default {
  import: ["node_modules/decisium/dist/steps.js", "steps/**/*.js"],
  format: ["decisium/formatter"],
  worldParameters: { decisium: { record: "none" } },
};
```

## Agent skill

A skill for coding agents (Claude Code, Cursor, Codex, pi…): designs scenarios from app code or requirements, writes
features and repairs failing Steps.

```sh
npx skills add andletenkov/decisium
```

It also ships in the package: `$(npm root -g)/decisium/skills/decisium/SKILL.md`.
