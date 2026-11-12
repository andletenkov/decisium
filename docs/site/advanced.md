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

The cassette records what Jev decided; network replay records what the backend answered. They are separate files and
separate choices: without the tag every request goes to the real backend, in replay too.

### What is recorded

- Only requests whose URL matches the glob (Playwright's URL glob: `**/api/**`, `https://api.example.com/**`). Pages,
  scripts, images and every other request go to the network as usual.
- The tag goes on a Scenario, or on the Feature for all its Scenarios. One glob per tag.
- One recording per Scenario: `<feature>.network/<scenario>.har`, response bodies in files beside it. Commit the
  folder with the cassette. A Scenario Outline's rows share one name, so they share one recording (the last row's).
- WebSockets and server-sent events are not recorded.

### How `--record` treats it

| `--record` | Matching requests |
|---|---|
| `new` (default) | Replayed if the Scenario has a recording, otherwise sent to the backend and recorded. |
| `none` | Replayed. A Scenario with no recording fails to start. |
| `all` | Sent to the backend and recorded again. |

A cassette Step that heals (see [CI](ci.html)) still gets its backend answers from the recording: only Jev is asked
again, never the backend.

### How a request is matched on replay

By method and URL, and by the order of calls: the third `GET /api/campaigns` gets the third recorded answer. The
request body is ignored, so a POST with a timestamp or a generated id in it still matches. The recorded status, headers
and body are served as they were.

A matching request that the recording does not have (a new endpoint, one call more than recorded) is never sent to the
real backend. It is aborted, and the Step that made it fails with:

```text
network not in recording: GET https://app.example.com/api/campaigns?page=2 (re-record with --record all)
```

Re-record the Scenario with `--record all` and commit the new `.har`.

### When to use it

- The backend is slow or costly per call (an LLM, a payment sandbox).
- Its answers change between runs (live prices, a feed), so a recording keeps the checks stable.
- CI has no backend: record locally against a running one, replay in CI with `--record none`.

Do not use it to test the backend itself: a replayed Scenario never reaches it. To mock one answer in code instead, use
a [client step](#client-steps) with Playwright's `context.route`.

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
