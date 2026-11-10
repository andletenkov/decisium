# Troubleshooting

A failed run prints the reason under each Step and writes `runs/<timestamp>/`: `report.md` (the Step, Jev's answers,
the page text, a rerun command, ready for a coding agent), a screenshot, a Playwright trace and `log.txt`.

## Outcomes

| Outcome | Means | Do |
|---|---|---|
| `ASSERTION_FAILED` | The app is wrong. | Fix the app, not the Step. |
| `AMBIGUOUS` | The Step could mean more than one element. | Quote the label or name the area, or [pin](ci.md#pin-an-ambiguous-target) a candidate. |
| `UNVERIFIABLE` | The check quotes nothing to compare, or its evidence never arrived: the area it names is not on the screen, or was still loading. | Quote the expected value; name an area that is on the screen; check what the loaded page shows first. |
| `ELEMENT_NOT_FOUND` | Nothing matches the Step. | Use the page's own label. |
| `BLOCKED` | The task cannot be done on this page. | Check the start URL and earlier Steps; menus may need "hover". |
| `ACTION_FAILED` | The action did not take effect. | Check the value's format (ISO for dates). |
| `STEP_TIMEOUT` | Too many actions for one Step. | Split the Step, or raise `maxTurns`. |
| `UI_CHANGED` | A replayed Step no longer matches the page, or its cassette predates a reading the check now needs. | Re-record with `--record new` if intended. |
| `PAGE_TOO_LARGE` | The page is over the model's limit. | Test a narrower page or state. |
| marginal pass | Passed, but Jev was barely sure. | Make the Step more specific. `--strict` fails it. |
| check fails on a slow page | The state came after the check gave up. | Raise `checkTimeout`. |
| absence `UNVERIFIABLE`: "a request is in flight" | The last action started a request that never ends (a long poll, a live feed), so the page never proves the text is gone. | Check what the page shows instead (`"X" should appear` for the state that replaces it), or put the absence check before the action that opens the feed. |

## A Step passes sometimes

Live runs ask Jev each time; replays do not. Record once and run CI with `--record none`. If a live Step still
wavers, reword it: `I leave by the "Search page" link`, not `I leave for the search page`.

## "Step definitions are loaded twice"

Your `cucumber.mjs` imports Decisium's steps and `decisium run` adds them again. Drop the import, or run
`npx cucumber-js` instead.
