# Decisium

**UI tests in plain English. No selectors.**

![Decisium running a checkout scenario](assets/demo.gif)

```sh
npm install -g decisium && decisium install
decisium run checkout.feature                  # live: records checkout.cassette.json
decisium run checkout.feature --record none    # replay in CI: no model calls
```

- **No selectors.** A Step says what the user wants; Decisium finds the element.
- **Record and replay.** CI replays recorded Steps: fast, free, the same result every run.
- **Code decides pass or fail**, not the model.
- **Built on cucumber-js and Playwright.** Your config, formatters and step definitions keep working.

Steps are resolved by Jev, TypeSafe's decision model.

[Getting started](getting-started.md) · [Examples](examples.md) · [How it works](how-it-works.md)
