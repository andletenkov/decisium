# Troubleshooting

## A Step fails sometimes, passes other times

A live run asks Jev every time, so a Step whose wording is borderline can end differently from run to run.

1. **Replay in CI.** Record once, check the outcomes, commit the cassettes and run CI with `--record none`: every Step
   replays what it resolved to, with the same outcome every run. Live variation only matters while recording. See
   [Record and replay](record-replay.md).
2. **Read the reason, then reword.** An `AMBIGUOUS` reason names what the Step could mean. Quote the one you mean:
   `I leave for the search page` can mean two links; `I leave by the "Search page" link` cannot. When it is unclear
   *how* (a Search button or Enter), say how: `… and press Enter`.
3. **Keep together what the page cannot do separately.** If a filter only applies when Search is clicked,
   `I filter the users by role "Admin"` clicks it; a following `I search` has nothing left to do.
4. **`AMBIGUOUS: Jev chose … which is not "…"`** after a Step that already did the task: the Step before it finished
   the job (`I run the workflow` confirmed the dialog), so `I confirm with "Run workflow"` only finds a lookalike.
   Merge them: `I run the workflow, confirming with "Run workflow"`.
5. **Still unstable: a [client step](client-steps.md).** Code can use any Playwright locator. Each one marks a gap
   worth reporting.

## What an outcome means and what to do

| Outcome | Usually | Do |
|---|---|---|
| `ASSERTION_FAILED` | The app is wrong. | Check the app, not the Step. |
| `AMBIGUOUS` | The Step could mean more than one thing. | Name the element or area; quote its label. |
| `UNVERIFIABLE` | The check quotes nothing to compare. | Quote the expected value or text. |
| `BLOCKED` | The task cannot be done on this page. | Check the start URL and the Steps before it; a hover menu needs "hover". |
| `ELEMENT_NOT_FOUND` | Nothing matches what the Step names. | Use the page's own label. |
| `ACTION_FAILED` | The action ran but did not take effect (e.g. a field rejected the value). | Check the value's format; for dates use ISO. |
| `STEP_TIMEOUT` | The Step did not finish in its allowed actions. | Split it into smaller tasks. |
| `UI_CHANGED` | A replayed Step no longer matches the page. | If the change is intended, re-record with `--record new`. |
| `PAGE_TOO_LARGE` | The page is over the model's size limit. | Test a narrower page or state. |
| marginal pass | Passed, but the model was barely sure. | Make the Step more specific. |

Run `npx decisium lint` on the feature: it flags many of these wordings before you run.

## Why not selectors

Selectors tie a test to markup, skip the model, and do not help with the most common failure: deciding when a Step is
done. Quote what the page shows instead.
