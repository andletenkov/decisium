# Quick start

## 1. Write a feature

```gherkin
# features/campaign.feature
@url:http://localhost:3000
Feature: Campaigns

  Scenario: Schedule a campaign
    When I enter "Autumn Sale" as the campaign name
    And I set the activation period to 2 weeks
    And I schedule the campaign
    Then the campaign status should be "Scheduled"
```

The `@url:` tag is the start URL (a URL or a local HTML file). Each Scenario starts from a fresh browser. Quote every
value a Step types or a check compares.

## 2. Lint it

```sh
decisium lint features/campaign.feature
```

No browser, no model: shows how each Step will be read and flags wordings [Writing Steps](steps.md) marks as ones to avoid.

## 3. Run it live

```sh
decisium run features/campaign.feature
```

The first run asks Jev for every Step and records the answers in `features/campaign.cassette.json`. Commit it.

## 4. Replay it

```sh
decisium run features/campaign.feature --record none
```

Every Step replays its recorded resolution with zero model calls. Use this in [CI](ci.md).

When a Step fails, read [Reports and debugging](reports.md). When a wording does not work, look it up in the
[Writing Steps](steps.md) and [Troubleshooting](troubleshooting.md).
