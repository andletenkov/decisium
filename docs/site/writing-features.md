# Writing features

A Decisium feature is ordinary Gherkin. Any `Given`/`When`/`Then`/`And` line that no step definition of yours matches is
run by Decisium.

## Start URL

`@url:<url|file>` on the feature or a scenario (a scenario's tag wins), or `--url` on the command line. A relative file
path resolves from the directory you run in.

## Kinds of Step

Decisium reads each line as one of these:

| Kind | Example | What happens |
|---|---|---|
| Step (action) | `I schedule the campaign` | Jev picks actions until the task is done. |
| Navigation | `I go to "/settings"`, `I go back` | Done by code, no model. |
| Value check | `the campaign status should be "Scheduled"` | Code compares the element's value with the quote. |
| Presence | `"Saved" should appear` | Code looks for the text. |
| Scoped presence | `"Banana" should appear in the cart` | The same, inside one area. |
| State check | `"Banana" should be selected` | Code reads the element's state. |
| Attempt | `I try to save the form` | A negative path: the action may be refused. |

The [Cookbook](cookbook.md) lists, for each kind, the wordings that pass and the ones to avoid, each backed by a
Step in the repository's `test/fixtures/`. Ready-to-run features are on the [Examples](examples.md) page.

## Rules

- One Step, one task, named by what the user wants: "I save the draft", not "I click Save draft".
- Quote every value: what to type, the option to pick, the text a check expects.
- Secrets go in as `"$NAME"`; the value comes from the environment or `.env`. Jev, logs, the trace and the cassette
  only see the token. A value written literally in a Step is sent to the model and recorded.
- Tables and doc strings work as in cucumber.

## Your own step definitions

Pass them with `--import`. A line one of them matches runs your code, not Jev. The World gives you `this.page` (the
current tab) and `this.context` (the Playwright browser context).

```js
// steps/network.js
import { When } from "@cucumber/cucumber";
When("the API is offline", async function () {
  await this.context.route("**/api/**", route => route.abort());
});
```

```sh
npx decisium run features/offline.feature --import steps/network.js
```
