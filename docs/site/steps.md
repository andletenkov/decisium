# Writing Steps

A Step is one line of a scenario, written the way a user would describe the task. Decisium reads each line as an
**action** (it changes the page) or a **check** (it verifies what the page shows). This page lists what each kind can
do and how to word it. `npx decisium lint <file.feature>` flags the wordings marked **Avoid** below.

## Rules of thumb

1. **One Step, one task**, named by what the user wants, not by the clicks: `I save the draft`, not
   `I click the button labelled Save draft`.
2. **Quote every value**: what to type, the option to pick, the text a check expects. Decisium only uses values you
   quoted; it never invents one. A number with a unit can stay unquoted (`2 weeks`).
3. **A check quotes exactly what it compares**: one value for a value check, the text to look for in a presence check.
4. **Name things the way the page labels them**: "heading", "error", "status", "the calendar". Avoid words that also
   name something else; "title" can also mean the browser tab's title.
5. **Say "open" when you mean open.** "Search for" runs a search; it does not open a result.
6. **Write `"$NAME"` for secrets.** See [Secrets](#secrets).
7. **No CSS or XPath selectors.** Quote what the page shows (`the "Search page" link`). When no wording works, write a
   [client step](client-steps.md).

## Actions

An action Step runs in Turns: each Turn Jev picks one action among the elements on the page, Decisium performs it,
and the Step ends once the task is done. Several clicks in one Step are fine when they serve one task: `I delete the
campaign` opens the "More actions" menu first. A live action waits for the requests it started to finish (up to 5 s), so
the next Step sees their result. A replay waits like a Playwright spec instead: see [Waiting on replay](record-replay.md#waiting-on-replay).

A Step may finish the task in the Step after it: `I publish the post` also confirms its dialog. Do not split what one
task covers; quote the control instead: `I publish the post, confirming with "Publish now"`. A click never lands on a
lookalike of a quoted control: when the Step quotes "Publish now" and Jev picks "Publish again" (a shared word, plus
one the quote lacks), the Step fails as `AMBIGUOUS` and nothing is clicked. A control made only of the quote's words
("Publish") may lead to it, and a control in the quoted row or card (its "Delete") is that row's.

### Navigate

| Write | Why |
|---|---|
| `I open the calendar` | Names the place, not the link. |
| `I open the "Spring Sale" campaign` | The quoted name picks the row. |
| `I start a new campaign` | The task, not the button text. |
| `I open the "Ada Lovelace" article through the search` | Says how and that it opens: types, submits, then opens the result. |
| `I go to "/settings"` | A path, query (`"?tab=2"`), `#hash` or full URL opens directly, relative to the start URL. |
| `I go back`, `I go forward`, `I reload the page` | Done directly, without the model. |
| `I open the contacts` | A link that opens a new tab: the following Steps act in the new tab. |
| `I close the tab`, `I switch back to the previous tab` | Done directly. Say them as their own Step. |

**Avoid** `I search for "Ada Lovelace"` when you want the article: the search runs, the result is never opened.

### Type

| Write | Why |
|---|---|
| `I enter "Winter Sale" as the campaign name` | Value quoted, field named. |
| `I set the activation date to "2026-12-01"` | Dates in the format the field takes. |
| `I search for "Ada" and submit the search` | "and submit" makes typing alone not enough. |
| `I clear the Search field` | Types an empty value. |

After typing, Decisium leaves the field (so on-leave validation runs) and checks that the field holds the value; if it
does not, the Step fails as `ACTION_FAILED`. Native inputs take ISO values: date `"2026-10-20"`, time `"14:30"`,
datetime-local `"2026-10-20T14:30"`. Custom date pickers are clicked like any widget. A range input (slider) is filled
like a text field: `I set the volume to "75"`.

### Select

`I set the activation period to 2 weeks`: a native select's options are the choices; the value can be quoted or a
number with a unit. Decisium checks the option was chosen.

### Submit and act

`I save the draft`, `I schedule the campaign`, `I delete the campaign`. Name the task; Decisium finds the control.

### Attempt

A Step starting with "try" or "attempt" is done once the action ran, even if the app refuses it. Use it for negative
paths and check the refusal after it:

```gherkin
When I try to schedule the campaign
Then the error should say "Set an activation date before scheduling"
```

### Radios and toggles

| Write | Why |
|---|---|
| `I accept the terms` | Clicking a checkbox, switch or radio means "on"; Decisium reads the box after the click. |
| `I turn off dark mode` | Disable, turn off, decline, reject, opt out, unsubscribe mean "off". |
| `I choose Express shipping` | A radio is done once it is checked. |
| `I check "Weekly digest"`, `I uncheck "Newsletter"` | Decided by code, when the Step does nothing else. |

Already in the wanted state: the Step is done without a click. **Avoid** `I check "Weekly digest" and save`: split it.

### Keys

A key is pressed only when the Step names it after "press" or "hit": Playwright's names (`Escape`, `Tab`,
`ArrowDown`, `PageDown`, `Home`, `F2`, …), aliases (`Esc`, `down arrow`, `Return`, `Space`) and `+` combinations
(`Ctrl+K`, `Shift+Tab`; `Ctrl` is Control, `Cmd` is Meta). The key goes to whatever has focus.

| Write | Why |
|---|---|
| `I press Escape` | Only a key: pressed directly, without the model. |
| `I open the command palette by pressing Ctrl+K` | The key is offered next to the page's elements. |
| `I press the down arrow`, `I press "Tab"` | Aliases and quotes both work. |

**Avoid** `I close the help with the Escape key`: without "press" or "hit" no key is pressed.

### Hover

`I hover over the help button`: say "hover" for a tooltip or a menu that opens on mouse-over; a plain click would close
it again. What the hover shows is then part of the page: `the tooltip should say "Opens the docs"`. A `title`
attribute needs no hover: `the Save button's tooltip should be "Save your work"`.

### Double-click, right-click, drag and sliders

| Write | Why |
|---|---|
| `I double-click the note title and change it to "Groceries"` | Say the edit in the same Step, not just the double-click. |
| `I right-click report.pdf and choose "Delete"` | The custom context menu is used in the next Turn. |
| `I drag "Fix bug" to the Done list` | Decisium picks where to drop it among the page's areas. |
| `I set the volume to "75"` | A slider is filled with the quoted value. |

### Scroll inside lists and panels

`I scroll down the Inbox until "Message 15" is shown`, `I scroll up the Chat until "Chat line 5" is shown`. A panel
that scrolls on its own is offered as a target. Content already rendered is visible without scrolling; only
lazy-loaded content needs it.

### Files and downloads

| Write | Why |
|---|---|
| `I upload "notes.txt" with the Attach file button` | "upload" or "attach" plus a quoted path (relative to the feature file). Hidden file inputs work. |
| `I export the contacts as CSV` | The download is saved to the scenario's run folder. |
| `the downloaded file name should be "contacts.csv"` | The last download's name. |
| `the downloaded file should contain "Ada Lovelace,engineer"` | A text file's contents; binary files only by name. |

### Clipboard

| Write | Why |
|---|---|
| `I copy the invite link` | Clicked like any button; the page may use the clipboard. |
| `the copied text should be "https://example.com/invite/7f3a"` | What was copied during the scenario. |
| `I paste into the message box` | Pastes the clipboard (Ctrl/Cmd+V). With a quoted value it types it instead. |

### Browser dialogs

`alert`, `confirm`, `prompt` and "Leave site?" are answered by the Step that opens them: OK (or leave) only when the
Step clearly means it, otherwise Cancel. An alert is closed. A prompt gets the Step's quoted value. Until the next
action, the dialog's message can be checked.

| Write | Why |
|---|---|
| `I delete the "Groceries" note` | Clicks Delete, then confirms: the Step asks for the deletion. |
| `I start deleting the "Ideas" note but cancel` | Says to cancel: Cancel. |
| `I rename the list to "Errands"` | The prompt gets the quoted value. |
| `the confirm should say "Delete the Groceries note?"` | The last dialog's message. |
| `I leave by the "Search page" link` | "Leave site?" is accepted because the Step means to leave. |

**Avoid** `I accept the confirm` as its own Step: the Step before already answered it. Say the intent in the Step that
opens the dialog.

### iframes and web components

Elements inside iframes and open shadow roots are part of the page like any other: no frame or component to name.
`I enter "ada@example.com" in Email` works when the field is in an iframe.

## Checks

A check is decided by code, not by the model. Jev only identifies *what* to look at (the subject) and *what kind* of
check it is; code then compares. A check that cannot be compared is `UNVERIFIABLE`, not passed.

Like Playwright's `expect`, a check that does not pass yet is retried each time the page changes, until it passes or
the page has nothing left pending (up to 5 s). A check that already holds passes at once, so check what only the new
state shows.

### Value checks

| Write | Why |
|---|---|
| `the campaign status should be "Draft"` | One subject, one quoted value. |
| `the error should say "Set an activation date before scheduling"` | |
| `the activation period should be "2 weeks"` | Reads a select's chosen option. |
| `the Email field should be "ada@example.com"` | A field's current value. |

The subject is picked by meaning: if the status says "Draft" while a filter elsewhere says "Scheduled",
`the campaign status should be "Scheduled"` correctly fails.

**Avoid**: `the article title should be "Ada Lovelace"` ("title" is also the tab's title; say "heading"),
`… should be "Ada" or "Ada Lovelace"` (exactly one value), `the article should be well written` (subjective; see
[Judged checks](#judged-checks)).

### Presence

| Write | Why |
|---|---|
| `"Saved" should appear` | The text anywhere on the page. |
| `the article should say "born 10 December 1815"` | The text anywhere in the subject. |
| `"Charles Babbage" should not appear in the results` | Absence. |

**Avoid** `the results should be shown`: it quotes nothing to look for.

### Scoped presence

`"Winter Sale" should appear in the calendar`, `"Spring Sale" should not appear in the campaign list`. Only text inside
the named area counts; the same name in a toast elsewhere does not. The area must be on the screen: open it first.

### State checks

`the "Schedule" button should be disabled`, `"Newsletter" should be unchecked`. States: disabled, enabled, checked,
unchecked, expanded, collapsed, selected, pressed. An unquoted name works when it is unique.

### Memory

A check may refer back to a value an earlier Step quoted: after `I enter "Winter Sale" as the campaign name`,
`the campaign should appear in the calendar` looks for "Winter Sale". When the scenario quoted several values and it
is unclear which one is meant, the check is `UNVERIFIABLE`: quote the value.

### Judged checks

A subjective check (`the article should be well written`) cannot be compared by code. With `--judged`, Jev judges it
and the result is reported as `JUDGED_PASSED` or `JUDGED_FAILED`, never as a plain pass.

### Marginal passes

A check that passed while the model was barely sure what it was looking at is reported as a **marginal pass**: passed,
with a warning. Treat it like an unclear wording and make the Step more specific; `--strict` fails it as `AMBIGUOUS`.

## More

### Data tables

An action's table runs one Step per row:

```gherkin
When I fill in the new contact:
  | First name | Ada      |
  | Last name  | Lovelace |
```

Two columns are label/value pairs, one column is a list of values, three or more columns are rows under a header row.
A check's table is matched row by row to a table on the page by column header (extra rows and any order pass; say
"exactly" or "in this order" to be strict). A one-column check table lists values that must all be shown; "should not
show:" checks that none is. Absence of table rows cannot be checked. Table cells cannot be empty or contain `"`.

A doc string is one more quoted value, line breaks kept:

```gherkin
When I write the notes:
  """
  Wrote the first program.
  Born in London.
  """
```

### Secrets

Write `"$NAME"` in a Step's quotes: `I log in as "$SAUCE_USER" with password "$SAUCE_PASSWORD"`. The value comes from
the environment or `.env` and is typed into the page; the model, logs, traces and cassettes only see the token, and it
is masked back wherever the page shows it. A missing variable is a setup error. A scenario that typed a secret keeps no
Playwright trace. Password fields are always masked. A value written literally in a Step is sent to the model and
recorded.

### Out of scope

Canvas drawing, maps, captchas, 2FA codes and closed shadow roots cannot be seen or driven by Steps. Use a test mode in
the app, or a [client step](client-steps.md) (for example, compute a 2FA code from its secret).
