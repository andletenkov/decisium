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
| `APP_ERROR` | The Step was blocked, and a server error (5xx) on a request it needed explains why. See [failed requests](#failed-requests). | Fix the backend; rerun if intermittent. To test an expected error, check for its message. |
| `RATE_LIMITED` | The Step was blocked, and a request it needed got 429 Too Many Requests. See [failed requests](#failed-requests). | Run fewer scenarios in parallel, or raise the test environment's limit. |
| `NETWORK_ERROR` | The Step was blocked, and a request it needed got no response. See [failed requests](#failed-requests). | Check the app and its API are reachable from the test machine. |
| `ACTION_FAILED` | The action did not take effect. | Check the value's format (ISO for dates). |
| `STEP_TIMEOUT` | Too many actions for one Step. | Split the Step, or raise `maxTurns`. |
| `UI_CHANGED` | A replayed Step no longer matches the page and no model key was given to resolve it again. | Provide the key, or re-record with `--record new`. |
| `PAGE_TOO_LARGE` | The page is over the model's limit. | Test a narrower page or state. |
| marginal pass | Passed, but Jev was barely sure. | Make the Step more specific. `--strict` fails it. |
| check fails on a slow page | The state came after the check gave up. | Raise `checkTimeout`. |
| absence `UNVERIFIABLE`: "a request is in flight" | The last action started a request that never ends (a long poll, a live feed), so the page never proves the text is gone. | Check what the page shows instead (`"X" should appear` for the state that replaces it), or put the absence check before the action that opens the feed. |

## Failed requests

Decisium records the requests of the page that fail: its document and its fetch/XHR calls that answer 400 or more, or
get no response. A cancelled request is not a failure, and a new page starts with none.

- Every Step reports them (`failedRequests` in `trace.jsonl`), and a failed Step's reason ends with
  `Failed requests since the page loaded: GET https://api.example.com/records/42 -> 500`. Each request is listed
  once, the latest 20; query values named like a key, token, secret, signature, auth or password show as `***`.
- When an Action step is blocked (it would end `AMBIGUOUS`, `BLOCKED`, `ELEMENT_NOT_FOUND` or `STEP_TIMEOUT`) and some
  of those requests answered 5xx, 429 or nothing, Jev is asked which of them, if any, was for what the Step needs. A
  tracker on a dead host fails on many sites and is not the Step's. Jev's confidence in all the requests together,
  against none, decides whether they blocked the Step, so several failed requests the Step needs do not split it
  below the bar. The kind holding most of it sets the outcome: 5xx `APP_ERROR`, 429 `RATE_LIMITED`, no response
  `NETWORK_ERROR`, and the reason names its requests, likeliest first, with the outcome it replaces:
  `GET https://api.example.com/records/42 -> 500 (AMBIGUOUS: Jev is unsure what to do next: …)`. If Jev picks none,
  or is unsure, the Step keeps its own outcome.
- Other 4xx (a 401 for a signed-out visitor, a 404 the app expects) are listed but never change an outcome.
- A response from another origin without CORS headers cannot be read by the page, so the browser reports no response:
  a gateway's 429 without them shows as `NETWORK_ERROR`, not `RATE_LIMITED`. Add the CORS headers to the gateway's
  error answers too.
- Checks keep their outcome: a Scenario that expects an error page checks for its message, and passes.
- The question costs one Jev call, only for a blocked Step whose page has such failures. It is never recorded, so a run
  with `--record none` and no model key keeps the Step's own outcome.

## A Step passes sometimes

Live runs ask Jev each time; replays do not. Record once and run CI with `--record none`. If a live Step still
wavers, reword it: `I leave by the "Search page" link`, not `I leave for the search page`.

## "Step definitions are loaded twice"

Your `cucumber.mjs` imports Decisium's steps and `decisium run` adds them again. Drop the import, or run
`npx cucumber-js` instead.
