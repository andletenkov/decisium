# Writing Steps

A Step is one line of a scenario, written the way a user would describe the task. Decisium reads each line as an
**action** (it changes the page) or a **check** (it verifies what the page shows). This page lists what each kind can
do and how to word it. `decisium lint <file.feature>` flags the wordings marked **Avoid** below.

## Rules of thumb

Steps can be written in any wording and, with Gherkin's `# language:` header, in any language Jev reads
(https://github.com/andletenkov/decisium/blob/main/`examples/saucedemo-de.feature`). The phrasings on this page are read without the model and are always exact; other
wordings are read by Jev, once per Step, and replayed from the cassette.

1. **One Step, one task**, named by what the user wants, not by the clicks: `I save the draft`, not
   `I click the button labelled Save draft`.
2. **Quote a value when the exact text matters**: what to type, the option to pick, the text a check expects. A
   quoted value is used exactly as written. Unquoted values (`I name the campaign Spring Launch`) are picked out of
   the Step by Jev and used only when it is sure; Decisium never invents a value that is not in the Step.
3. **A check quotes exactly what it compares**: one value for a value check, the text to look for in a presence check.
4. **Name things the way the page labels them**: "heading", "error", "status", "the calendar". Avoid words that also
   name something else; "title" can also mean the browser tab's title.
5. **Say "open" when you mean open.** "Search for" runs a search; it does not open a result.
6. **Write `"$NAME"` for secrets.** See [Secrets](#secrets).
7. **No CSS or XPath selectors.** Quote what the page shows (`the "Search page" link`). When no wording works, write a
   [client step](https://andletenkov.github.io/decisium/advanced.html#client-steps).

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
| `I search for "Ada"` | A search that shows results as you type: typing is the whole action. |
| `I search for "Ada" and submit the search` | A search that shows results only on submit: name the submit too. A Step is done once every action it names has run and visibly changed the page, so name only actions this page has. |
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

A Step that tries something the app may refuse is done once the action ran, even if the app refuses it. Starting it
with "try" or "attempt" makes that certain; other wordings (`I submit the empty form`, `intento continuar sin
rellenar el formulario`) are recognised by Jev. Use it for negative paths and check the refusal after it:

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

A key named after "press" or "hit" is always pressed; other wordings (`I close the help with the Escape key`) are
recognised by Jev. Key names are Playwright's (`Escape`, `Tab`,
`ArrowDown`, `PageDown`, `Home`, `F2`, …), aliases (`Esc`, `down arrow`, `Return`, `Space`) and `+` combinations
(`Ctrl+K`, `Shift+Tab`; `Ctrl` is Control, `Cmd` is Meta). The key goes to whatever has focus.

| Write | Why |
|---|---|
| `I press Escape` | Only a key: pressed directly, without the model. |
| `I open the command palette by pressing Ctrl+K` | The key is offered next to the page's elements. |
| `I press the down arrow`, `I press "Tab"` | Aliases and quotes both work. |

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

A check is decided by code, not by the model. Jev only identifies *what* to look at (the subject or area) and *what
kind* of check it is; code then collects the page's evidence and compares. Jev is never asked whether a check passes
(only `--judged` checks). A check that cannot be compared is `UNVERIFIABLE`, not passed.

Like Playwright's `expect`, a check that does not pass yet is retried each time the page changes, until it passes or
the page has nothing left pending (up to 5 s). A check that already holds passes at once, so check what only the new
state shows. Evidence that may still arrive is waited for, then reported as `UNVERIFIABLE`: an area or subject not on
the screen, or, for absence, a missing table row or "exactly these rows", an area that is still loading (`aria-busy`,
a progress bar without a value, a request in flight). A witness needs no wait: a shown text proves presence, and
contradicts absence, at once.

### Value checks

| Write | Why |
|---|---|
| `the campaign status should be "Draft"` | One subject, one quoted value. |
| `the error should say "Set an activation date before scheduling"` | |
| `the activation period should be "2 weeks"` | Reads a select's chosen option. |
| `the Email field should be "ada@example.com"` | A field's current value. |
| `the campaign status should not be "Scheduled"` | Passes on any other value; a missing status is `UNVERIFIABLE`. |

The subject is picked by meaning: if the status says "Draft" while a filter elsewhere says "Scheduled",
`the campaign status should be "Scheduled"` correctly fails. The subject must show the quoted text as whole words (case
and spacing aside): "Status: Draft" shows "Draft", "Redraft" does not. Containment cannot tell a negated value: "Not
Scheduled" shows "Scheduled", so quote the whole value where the app can show either.

"Should not" is one answer Jev gives for a value or text check, applied after code compares: `should not be
"Scheduled"`, `should not appear`. A state names its own: `should not be disabled` is `enabled`.

**Avoid**: `the article title should be "Ada Lovelace"` ("title" is also the tab's title; say "heading"),
`… should be "Ada" or "Ada Lovelace"` (exactly one value), `the article should be well written` (subjective; see
[Judged checks](#judged-checks)).

### Presence

| Write | Why |
|---|---|
| `"Saved" should appear` | The text anywhere on the page. |
| `the article should say "born 10 December 1815"` | The text anywhere in the subject. |
| `"Charles Babbage" should not appear in the results` | Absence. |

Presence finds the text literally: `"Scheduled" should appear` passes on "Not Scheduled".

**Avoid** `the results should be shown`: it quotes nothing to look for.

### Scoped presence

`"Winter Sale" should appear in the calendar`, `"Spring Sale" should not appear in the campaign list`. Only text inside
the named area counts; the same name in a toast elsewhere does not. The area must be on the screen: open it first.
A check whose words name no area reads the whole page, whatever is on the screen; no need to add "anywhere on the page".
An area not on the screen gives no evidence either way, so both checks end `UNVERIFIABLE` there. Name the area as the
page shows it (`the notes list`, not `the notes`): if Jev thinks the area may be missing, the check cannot pass.

An absence passes only once the area is complete. An app that loads a list without `aria-busy`, a progress bar or a
request in flight needs a Step that waits for the loaded list first (`"Autumn Sale" should appear in the campaign
list`), then the absence.

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

Every plausible reading of a check counts. Readings that pass together pass; readings that disagree are `AMBIGUOUS`;
a reading that cannot decide (no evidence, unsure) is not outvoted by one that passed, so the check is `AMBIGUOUS` or
`UNVERIFIABLE`, never a pass.

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

### Unique values

Use `{{decisium.runId}}` inside a Step's quotes, doc string or table cell for input that must differ on every run:

```gherkin
When I create an agent named "Autotest agent {{decisium.runId}}"
Then I see the agent named "Autotest agent {{decisium.runId}}"
```

Decisium generates a 16-character random ID once per CLI run, shared across scenarios and parallel workers. The model,
page and logs see the real value. Cassette entries store `{{decisium.runId}}` and substitute the current run's value during replay. Unlike secrets,
the value is included in traces. If the page reformats the ID, cassette replay may not recognize it.

When running cucumber-js directly with `--parallel`, set `DECISIUM_RUN_ID` to a fresh random ID before starting it so all
workers share the same ID. Other `{{...}}` expressions are not supported.

### Out of scope

Canvas drawing, maps, captchas, 2FA codes and closed shadow roots cannot be seen or driven by Steps. Use a test mode in
the app, or a [client step](https://andletenkov.github.io/decisium/advanced.html#client-steps) (for example, compute a 2FA code from its secret).
