# Decisium

**From behavioral specification to intelligent execution.**

Decisium runs Gherkin features written in plain English against a real browser. You write
`When I schedule the campaign`, not selectors. An AI model (Jev) only picks among the options Decisium shows it, and
Decisium's code, not the model, decides whether each Step passed.

```gherkin
@url:https://shop.example.com
Feature: Checkout

  Scenario: Buy a backpack
    When I add the "Backpack" to the cart
    And I check out with email "ada@example.com"
    Then the order status should be "Confirmed"
```

- **No selectors.** Steps name what the user wants. Decisium finds the element by meaning.
- **Record and replay.** What each Step resolved to is saved in a cassette next to the feature. CI replays it with zero
  model calls, and a real UI change fails as `UI_CHANGED`.
- **Built on cucumber-js and Playwright.** Your cucumber configuration, formatters, profiles and step definitions keep
  working.
- **Agent-ready failures.** A failed run writes `report.md`: the Step, the model's answers, the page text and a rerun
  command, ready for a coding agent.

Next: [Installation](installation.md), then the [Quick start](quick-start.md).
