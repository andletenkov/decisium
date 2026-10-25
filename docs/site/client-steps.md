# Client steps

Your own cucumber step definitions run next to Decisium. A line one of them matches runs **your code**; every other line
goes to Jev. Use them for setup the page cannot do (cookies, API login, mocks), for anything out of scope for Steps,
and as the fallback when no wording works.

```ts
// steps/campaigns.steps.ts
import { Given } from "@cucumber/cucumber";
import type { BrowserContext } from "playwright";

Given("the campaigns API returns {string}", async function (this: { context: BrowserContext }, name: string) {
  await this.context.route("**/api/campaigns", route => route.fulfill({ json: [{ id: 1, name, status: "Draft" }] }));
});
```

```gherkin
Scenario: The list shows what the API returns
  Given the campaigns API returns "Mocked Sale"
  When I click Load campaigns
  Then "Mocked Sale" should be shown
```

Load them with `--import` (repeatable) or `import` in your [configuration](configuration.md):

```sh
npx decisium run features/campaigns.feature --import steps/campaigns.steps.ts
```

A client step makes no model call and is not recorded in the cassette.

## The World

| Property | What it is |
|---|---|
| `this.page` | The current tab, a Playwright `Page`. A popup the app opens becomes the current tab. |
| `this.context` | The scenario's Playwright `BrowserContext`. |

Client steps run after the start page has opened, so a mock covers requests made from then on (for example, by the next
click).

## Recipes

| Need | Code |
|---|---|
| Mock a request | `this.context.route(glob, route => route.fulfill({ json }))` |
| Cookies | `this.context.addCookies([{ name, value, url }])`, then `this.page.reload()` if the page already read them |
| Local storage | `this.page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value])`, then `this.page.reload()` |
| Log in through the API | `await this.context.request.post(url, { data })` shares cookies with the page; then reload. Faster than the form. |
| Permissions | `this.context.grantPermissions(["clipboard-read"])` |
| A second user | `const other = await this.context.browser()!.newContext()`, then `await other.newPage()`. Steps act on `this.page` only; drive and check the other user's page in code. |
| Wait for a request | Nothing to write: an action waits for the requests it started to finish (up to 5 s). |

Hooks (`Before`, `After`, …) and anything else cucumber offers work too.
