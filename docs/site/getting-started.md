# Getting started

Needs Node 22.18+ (or 23.6+).

## 1. Install

```sh
npm install --save-dev decisium   # or: npm install -g decisium
npx decisium install              # the Chromium build Decisium drives; --with-deps on Linux
```

A per-project install pins the version, so CI replays with the version that recorded. These docs write `decisium …`;
per project, type `npx decisium …`.

## 2. Add your API key

Live runs call Jev through the TypeSafe API. Replays need no key.

```sh
echo 'TYPESAFE_API_KEY=...' >> .env
decisium doctor                   # checks Node, Chromium and the key
```

## 3. Write a feature

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

`@url:` is the start URL (a URL or a local HTML file). Each scenario starts in a fresh browser. Quote every value a
Step types or a check compares. More: [Writing Steps](steps.md).

## 4. Run it

```sh
decisium lint features/campaign.feature          # no browser: how each Step will be read
decisium run features/campaign.feature           # live: writes campaign.cassette.json
decisium run features/campaign.feature --record none   # replay: no model calls
```

Commit the cassette and replay it in [CI](ci.md). When a Step fails, see [Troubleshooting](troubleshooting.md).

## What is sent to Jev

Per request: the Step's text and a text snapshot of the page (roles, names, visible text, link URLs). No screenshots,
cookies or network traffic. Secrets written as `"$NAME"` leave your machine only as the token. Replays send nothing.
Decisium is MIT; Jev is TypeSafe's hosted service under its own terms.
