# Writing Steps

A Step is an **action** (`When`, it changes the page) or a **check** (`Then`, code verifies the page). Any wording
works, in any language Jev reads (`# language: de`). `decisium lint` flags the wordings to avoid.

## Rules

1. **One Step, one task**, named by what the user wants: `I save the draft`, not `I click the Save draft button`.
2. **Quote exact values**: what to type, the option to pick, the text a check expects.
3. **Name things as the page labels them**: "the error", "the status", "the calendar".
4. **Say "open" to open.** `I search for "Ada"` runs a search; it does not open a result.
5. **Secrets as `"$NAME"`**, read from the environment or `.env`.
6. **No CSS or XPath.** When no wording works, write a [client step](advanced.md#client-steps).

## Actions

| To | Write |
|---|---|
| Open a place | `I open the calendar` · `I open the "Spring Sale" campaign` |
| Go to a URL | `I go to "/settings"` · `I go back` · `I reload the page` |
| Type | `I enter "Winter Sale" as the campaign name` |
| Clear a field | `I clear the Search field` |
| Select | `I set the activation period to 2 weeks` |
| Do a task | `I schedule the campaign` · `I delete the campaign` |
| Submit a search | `I search for "Ada" and submit the search` |
| Try what the app refuses | `I try to schedule the campaign` |
| Toggle | `I accept the terms` · `I turn off dark mode` · `I uncheck "Newsletter"` |
| Press a key | `I press Escape` · `I open the command palette by pressing Ctrl+K` |
| Hover | `I hover over the help button` |
| Drag, slider | `I drag "Fix bug" to the Done list` · `I set the volume to "75"` |
| Double/right click | `I right-click report.pdf and choose "Delete"` |
| Scroll a panel | `I scroll down the Inbox until "Message 15" is shown` |
| Upload | `I upload "notes.txt" with the Attach file button` (path relative to the feature) |
| Download | `I export the contacts as CSV` |
| Clipboard | `I copy the invite link` · `I paste into the message box` |
| Dialogs | `I delete the "Groceries" note` (confirms) · `I start deleting the "Ideas" note but cancel` |
| Tabs | `I close the tab` · `I switch back to the previous tab` |
| Confirm with a specific control | `I publish the post, confirming with "Publish now"` |

Inputs take ISO values: `"2026-10-20"`, `"14:30"`. iframes and open shadow roots work like the rest of the page.

## Checks

| To check | Write |
|---|---|
| A value | `the campaign status should be "Draft"` · `the Email field should be "ada@example.com"` |
| Not a value | `the campaign status should not be "Scheduled"` |
| An error | `the error should say "Set an activation date before scheduling"` |
| Text on the page | `"Saved" should appear` |
| Text in an area | `"Winter Sale" should appear in the calendar` |
| Absence | `"Charles Babbage" should not appear in the results` |
| A state | `the "Schedule" button should be disabled` · `"Newsletter" should be unchecked` |
| A tooltip | `the tooltip should say "Opens the docs"` |
| A download | `the downloaded file name should be "contacts.csv"` |
| The clipboard | `the copied text should be "https://example.com/invite/7f3a"` |
| A dialog | `the confirm should say "Delete the Groceries note?"` |
| An earlier value | `the campaign should appear in the calendar` (after quoting "Winter Sale") |

States: disabled, enabled, checked, unchecked, expanded, collapsed, selected, pressed. A subjective check
(`the article should be well written`) runs only with `--judged` and reports `JUDGED_PASSED` / `JUDGED_FAILED`.

Quoted text is found as whole words, in a value or on the page: "Status: Draft" shows "Draft". It cannot tell a
negated value ("Not Scheduled" shows "Scheduled"): quote the whole value where the app can show either. Absence, a missing table row and "exactly these
rows" need the whole area on the screen and done loading; until then the check waits, then reports `UNVERIFIABLE`.
The app's own signals count (`aria-busy`, a progress bar, a request in flight). An app that shows none while a list
loads needs a Step that waits for the loaded list first, e.g. `"Autumn Sale" should appear in the campaign list`.

## Tables, doc strings, unique values

```gherkin
When I fill in the new contact:
  | First name | Ada      |
  | Last name  | Lovelace |
And I write the notes:
  """
  Wrote the first program.
  """
And I create an agent named "Autotest agent {{decisium.runId}}"
```

An action table runs one Step per row. A check table is matched to a table on the page by column header.
`{{decisium.runId}}` is a random ID, the same for the whole run.

## Out of scope

Canvas, maps, captchas, 2FA codes and closed shadow roots. Use a test mode in the app or a
[client step](advanced.md#client-steps).
