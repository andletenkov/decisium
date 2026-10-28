# Features and scenarios

A Decisium test is an ordinary Gherkin `.feature` file. Every line no [client step](client-steps.md) of yours matches is
run by Decisium.

```gherkin
@url:http://localhost:3000
Feature: Campaigns

  Background:
    When I start a new campaign

  Scenario: Schedule a campaign
    When I enter "Winter Sale" as the campaign name
    And I set the activation period to 2 weeks
    And I schedule the campaign
    Then the campaign status should be "Scheduled"

  Scenario Outline: Name validation
    When I try to save the draft with the name "<name>"
    Then the error should say "<error>"

    Examples:
      | name | error              |
      | x    | Name is too short  |
```

- **Start URL:** `@url:` on the feature or a scenario (a URL or a local HTML file), or `--url`. More tags set the
  viewport, locale, time zone and geolocation: [Browser context](browser-context.md).
- **Isolation:** each scenario, and each Examples row of an outline, runs in a fresh browser. `Background` Steps run
  before each scenario.
- **Steps:** each line is an action (it changes the page) or a check (code verifies what the page shows). How to word
  them: [Writing Steps](steps.md).
- **Tables and doc strings** work as in cucumber: [Data tables](steps.md#data-tables).
- **One scenario:** `decisium run file.feature:12` runs only the scenario (or Examples row) at line 12.

## How a Step runs

1. Decisium reads the page as text: its accessibility tree (roles, names, text, states).
2. For an action, Jev picks one of the actions that page offers (click this button, type this quoted value into this
   field, press a named key, go back, …). Decisium performs it and reads the page again, until the task is done.
3. For a check, Jev picks the subject and the kind of check; code compares the quoted value with the page.
4. What each Step resolved to is saved in a [cassette](record-replay.md), so the next run can replay it without Jev.

Jev never writes code or selectors; it only chooses among options Decisium lists, so a Step can only act on what is
really on the page.
