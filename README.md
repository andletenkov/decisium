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

<p align="center"><img alt="Decisium running a checkout scenario" src="https://raw.githubusercontent.com/andletenkov/decisium/main/site/assets/demo.gif" width="800"></p>

Write what the user does. Decisium runs it in a real browser:

```gherkin
@url:https://www.saucedemo.com/
Feature: Checkout

  Scenario: Checkout requires a first name
    When I log in as "standard_user" with password "secret_sauce"
    And I add "Sauce Labs Backpack" to the cart
    And I open the cart
    And I start the checkout
    And I try to continue without filling in the form
    Then the error should say "First Name is required"
```

- **No selectors**, no page objects, no step definitions.
- **Record and replay.** CI replays recorded Steps with zero model calls; a real UI change fails as `UI_CHANGED`.
- **Code decides pass or fail**, not the model.
- **Built on cucumber-js and Playwright.** Your config, formatters and step definitions keep working.

Steps are resolved by Jev, TypeSafe's decision model: it picks among the elements on the page, never writes code.
[How it works](https://andletenkov.github.io/decisium/how-it-works.html)

## Quick start

```sh
npm install --save-dev decisium && npx decisium install
echo 'TYPESAFE_API_KEY=...' >> .env             # live runs only

npx decisium run checkout.feature                  # live: records checkout.cassette.json
npx decisium run checkout.feature --record none    # replay in CI: no model calls, no key
```

Node 22.18+ or 23.6+. A failed run writes `runs/<timestamp>/report.md`, ready for you or a coding agent.

## Docs

**[andletenkov.github.io/decisium](https://andletenkov.github.io/decisium/)**: [Getting started](https://andletenkov.github.io/decisium/getting-started.html) ·
[Writing Steps](https://andletenkov.github.io/decisium/steps.html) · [CLI and configuration](https://andletenkov.github.io/decisium/configuration.html) · [CI](https://andletenkov.github.io/decisium/ci.html) ·
[Troubleshooting](https://andletenkov.github.io/decisium/troubleshooting.html) · [Advanced](https://andletenkov.github.io/decisium/advanced.html)

OpenRouter is optional: `npm install @openrouter/sdk`, set `OPENROUTER_API_KEY`, then run with
`--provider openrouter` (default model `~typesafe/jev-latest`). TypeSafe remains the default.
See [provider configuration](docs/configuration.md#decision-providers) for the supported SDK version and provenance.

Every option also has a `DECISIUM_*` environment variable: [CLI and configuration](https://andletenkov.github.io/decisium/configuration.html#environment-variables).

Agent skill for coding agents: `npx skills add andletenkov/decisium`.

## License

[MIT](LICENSE) © Andrei Letenkov
