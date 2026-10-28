<p align="center">
  <img alt="decisium" src="https://raw.githubusercontent.com/andletenkov/decisium/main/site/assets/logo-black.png#gh-light-mode-only" width="320">
  <img alt="decisium" src="https://raw.githubusercontent.com/andletenkov/decisium/main/site/assets/logo-white.png#gh-dark-mode-only" width="320">
</p>

<p align="center"><b>Semantic UI testing with decision models.</b><br>Plain-English Gherkin, a real browser, pass/fail decided by code.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/decisium"><img alt="npm" src="https://img.shields.io/npm/v/decisium?color=black"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/npm/l/decisium?color=black"></a>
  <a href="https://andletenkov.github.io/decisium/"><img alt="docs" src="https://img.shields.io/badge/docs-andletenkov.github.io%2Fdecisium-black"></a>
</p>

---

Write what the user does. Decisium runs it in Playwright:

```gherkin
@url:https://www.saucedemo.com/
Feature: Checkout

  Scenario: Checkout requires a first name
    When I log in as "standard_user" with password "$SAUCE_PASSWORD"
    And I add "Sauce Labs Backpack" to the cart
    And I open the cart
    And I start the checkout
    And I try to continue without filling in the form
    Then the error should say "First Name is required"
```

No selectors, no page objects, no step definitions.

## How it works

Each Step is executed by **Jev**, TypeSafe's decision model. Jev does not generate text or code. It picks among the
options Decisium enumerates from the page (elements, actions, check kinds) and returns a probability for each.
**Code, not the model, decides whether a Step passed**: a value check compares the element's value with the quoted one,
a presence check looks for the text, a state check reads the control's state. No LLM, no prompts, no invented selectors.

What each Step resolved to is recorded in a **cassette** next to the feature. CI replays it with **zero model calls**,
the same outcome every run; a real UI change fails as `UI_CHANGED`.

## Install

Global, one `decisium` command for every project:

```sh
npm install -g decisium
decisium install                     # the Chromium build Decisium drives
```

Or per project, with the version pinned in `package.json` (run commands as `npx decisium …`):

```sh
npm install --save-dev decisium
npx decisium install
```

Then:

```sh
echo 'TYPESAFE_API_KEY=...' >> .env   # live runs only; replays need no key
decisium doctor
```

Node 22.18+ or 23.6+.

## Use

```sh
decisium lint checkout.feature                 # how each Step will be read; flags known-bad wordings
decisium run checkout.feature                  # live: asks Jev, records checkout.cassette.json
decisium run checkout.feature --record none    # replay: zero model calls (CI)
decisium step "I open the cart" --url https://www.saucedemo.com/   # try one wording
```

A failed run prints the reason under each Step and writes `<reportDir>/<timestamp>/report.md` (`reportDir` defaults to `runs`): the Step, Jev's answers, the
page text around the element, a screenshot, a Playwright trace and a rerun command, ready for you or a coding agent.

Decisium runs inside cucumber-js: your `cucumber.mjs`, profiles, formatters (`--format junit:junit.xml`) and your own
step definitions (`--import`, with `this.page` and `this.context`) keep working.

## Configuration

Put Decisium options in `worldParameters.decisium` in your project's `cucumber.mjs`. `decisium run` loads it automatically:

```js
// cucumber.mjs
export default {
  worldParameters: {
    decisium: {
      url: "http://localhost:3000",
      reportDir: "e2e/runs",
      checkTimeout: 10000, // milliseconds to wait for the expected state
      actionTimeout: 10000, // milliseconds to wait for the page to settle after an action
      maxTurns: 12, // action Turns allowed per Step
      confidence: { target: 0.5, answer: 0.8 }, // default confidence thresholds
    },
  },
};
```

Precedence: **CLI flag > `DECISIUM_*` environment variable > configuration > default**. For example,
`--check-timeout 15000` overrides both `DECISIUM_CHECK_TIMEOUT` and `checkTimeout` in the file.

Raise timeouts for slow apps; raise `maxTurns` for long flows, or split the Step. Reword ambiguous Steps before
changing confidence. Lowering `confidence.answer` below 0.6 warns because a wrong reading can pass.

See [Configuration](https://andletenkov.github.io/decisium/configuration.html) for every option, default, flag,
environment variable, and reporter setup.

## Docs

**[andletenkov.github.io/decisium](https://andletenkov.github.io/decisium/)**

- [Quick start](https://andletenkov.github.io/decisium/quick-start.html)
- [Writing features](https://andletenkov.github.io/decisium/writing-features.html)
- [Writing Steps](https://andletenkov.github.io/decisium/steps.html): every kind of action and check, and how to word it
- [Client steps](https://andletenkov.github.io/decisium/client-steps.html) · [Browser context](https://andletenkov.github.io/decisium/browser-context.html) · [Network replay](https://andletenkov.github.io/decisium/network-replay.html)
- [Record and replay](https://andletenkov.github.io/decisium/record-replay.html) · [CI](https://andletenkov.github.io/decisium/ci.html) · [Configuration](https://andletenkov.github.io/decisium/configuration.html)
- [Examples](https://andletenkov.github.io/decisium/examples.html) against real public sites
- [Agent skill](https://andletenkov.github.io/decisium/agent-skill.html) for coding agents: designs CUJ-first scenarios from app code or requirements, writes and repairs features. Install with `npx skills add andletenkov/decisium` (also ships in the package: `$(npm root -g)/decisium/skills/decisium/SKILL.md`)

## Jev and your data

Live runs call Jev through the TypeSafe API and need a TypeSafe API key; Jev is TypeSafe's hosted service under its own
terms. Per Turn it receives the Step's text and a text snapshot of the page (the accessibility tree: roles, names,
visible text, link URLs). No screenshots, cookies or network traffic. Write credentials as `"$NAME"`: only the token
leaves your machine. Replays send nothing.

## License

[MIT](LICENSE) © Andrei Letenkov
