# Reports and debugging

## Console

One line per Step, the reason under a failed one, and a Failures block at the end with a rerun command per failed
scenario. A marginal pass (the check passed, but Jev was barely confident) is listed separately; treat it like an
unclear wording, or fail it with `--strict`.

## The run directory

Each run writes `<reportDir>/<timestamp>/` (`reportDir` defaults to `runs`, see [configuration](https://github.com/andletenkov/decisium/blob/main/docs/configuration.md)):

- `trace.jsonl`: Observations, Jev answers, actions and outcomes. Each scenario's `result` event has `perf`: milliseconds spent in `observe`, `perform:<verb>`, `after:<verb>` (waiting after an action) and `settle`, split by what held it (`settle:requests:<type>`, `settle:timers`, `settle:quiet`).
- `log.txt`: the full decision log (what `-v` prints).
- Per failed scenario: a screenshot per Turn (with `--record none`, of the failed Step only), `playwright-trace.zip`, `console-errors.txt` and `ui.txt` (the page text).
  Passed scenarios keep none.
- `report.md` when something failed: every failure with Jev's answers, the page text around it and a rerun command, for
  a coding agent. `--no-agent-report` turns it off.

## Outcomes

| Outcome | Meaning |
|---|---|
| `PASSED` / `DONE` | The check held / the action finished. |
| `ASSERTION_FAILED` | The app is wrong: the value or text is not what the Step expects. |
| `BLOCKED`, `ACTION_FAILED` | The action could not be done. |
| `ELEMENT_NOT_FOUND` | Nothing on the page matches what the Step names. |
| `STEP_TIMEOUT` | The Step took too many Turns without finishing. |
| `PAGE_TOO_LARGE` | The page is over the model's request limit. |
| `AMBIGUOUS` | Jev could not tell which element the Step means. Reword. |
| `UNVERIFIABLE` | The check quotes nothing code can compare. Reword. |
| `UI_CHANGED` | A replayed resolution no longer matches the page (`--record none`). |
| `JUDGED_PASSED` / `JUDGED_FAILED` | A fuzzy check judged by Jev (`--judged`). |

The [agent skill](agent-skill.md) shows how to classify a failure: the app is wrong, or the wording is unclear.
