<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/andletenkov/decisium/main/site/assets/logo-white.png">
    <img alt="decisium" src="https://raw.githubusercontent.com/andletenkov/decisium/main/site/assets/logo-black.png" width="320">
  </picture>
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

```sh
npm install --save-dev decisium
npx playwright install chromium
echo 'TYPESAFE_API_KEY=...' >> .env   # live runs only; replays need no key
npx decisium doctor
```

Node 22.18+ or 23.6+.

## Use

```sh
npx decisium lint checkout.feature                 # how each Step will be read; flags known-bad wordings
npx decisium run checkout.feature                  # live: asks Jev, records checkout.cassette.json
npx decisium run checkout.feature --record none    # replay: zero model calls (CI)
npx decisium step "I open the cart" --url https://www.saucedemo.com/   # try one wording
```

A failed run prints the reason under each Step and writes `runs/<timestamp>/report.md`: the Step, Jev's answers, the
page text around the element, a screenshot, a Playwright trace and a rerun command, ready for you or a coding agent.

Decisium runs inside cucumber-js: your `cucumber.mjs`, profiles, formatters (`--format junit:junit.xml`) and your own
step definitions (`--import`, with `this.page` and `this.context`) keep working.

## Docs

**[andletenkov.github.io/decisium](https://andletenkov.github.io/decisium/)**

- [Quick start](https://andletenkov.github.io/decisium/quick-start.html)
- [Writing features](https://andletenkov.github.io/decisium/writing-features.html)
- [Step cookbook](https://andletenkov.github.io/decisium/cookbook.html): wordings that pass and the ones to avoid, each backed by a replayed example
- [Record and replay](https://andletenkov.github.io/decisium/record-replay.html) · [CI](https://andletenkov.github.io/decisium/ci.html) · [Configuration](https://andletenkov.github.io/decisium/configuration.html)
- [Examples](https://andletenkov.github.io/decisium/examples.html) against real public sites
- An agent skill for coding agents ships in the package: `node_modules/decisium/skills/decisium/SKILL.md`

## Jev and your data

Live runs call Jev through the TypeSafe API and need a TypeSafe API key; Jev is TypeSafe's hosted service under its own
terms. Per Turn it receives the Step's text and a text snapshot of the page (the accessibility tree: roles, names,
visible text, link URLs). No screenshots, cookies or network traffic. Write credentials as `"$NAME"`: only the token
leaves your machine. Replays send nothing.

## License

[MIT](LICENSE) © Andrei Letenkov
