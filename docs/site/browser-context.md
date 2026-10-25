# Browser context

Each scenario starts in a fresh browser. Tags on the feature or the scenario set up that browser before the first page
opens. When the same tag is on both, the scenario's wins; when a tag repeats, the last one wins.

| Tag | Effect |
|---|---|
| `@url:<url\|file>` | The start URL: a URL or a local HTML file (relative to where you run). `--url` overrides it. |
| `@viewport:390x844` | Window size in pixels. |
| `@viewport:iPhone-13` | A Playwright device (dashes for spaces): size, user agent and touch. |
| `@locale:de-DE` | Browser language and number/date formats. |
| `@timezone:Europe/Berlin` | Time zone. |
| `@geolocation:52.52,13.40` | Position (latitude, longitude); the location permission is granted. |
| `@replay-network:<glob>` | Records and replays matching browser requests. See [Network replay](network-replay.md). |

```gherkin
@url:https://shop.example.com @locale:de-DE
Feature: Shop in German

  @viewport:iPhone-13
  Scenario: Checkout on a phone
    When I add the "Backpack" to the cart
    Then the cart badge should show "1"
```

Anything else about the browser (cookies, storage, permissions, mocked requests, a logged-in session) is set up with a
[client step](client-steps.md).
