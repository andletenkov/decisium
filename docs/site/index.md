# Decisium

**From behavioral specification to intelligent execution.**

Semantic UI testing with decision models. Decisium runs Gherkin features written in plain English against a real
browser. You write `When I schedule the campaign`, not selectors.

Each Step is executed by **Jev**, TypeSafe's decision model. Jev does not generate text or code: it picks among the
options Decisium enumerates from the page (the elements, the actions, the check kinds) and returns a probability for
each. Decisium's code, not the model, decides whether a Step passed. No LLM, no prompts, no hallucinated selectors.

```gherkin
@url:https://shop.example.com
Feature: Checkout

  Scenario: Buy a backpack
    When I add the "Backpack" to the cart
    And I check out with email "ada@example.com"
    Then the order status should be "Confirmed"
```

- **No selectors.** Steps name what the user wants. Jev picks the element by meaning, among the ones on the page.
- **Record and replay.** What each Step resolved to is saved in a cassette next to the feature. CI replays it with zero
  model calls, and a real UI change fails as `UI_CHANGED`.
- **Built on cucumber-js and Playwright.** Your cucumber configuration, formatters, profiles and step definitions keep
  working.
- **Agent-ready failures.** A failed run writes `report.md`: the Step, the model's answers, the page text and a rerun
  command, ready for a coding agent.

Next: [Installation](installation.md), then the [Quick start](quick-start.md).
