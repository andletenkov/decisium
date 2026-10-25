# Record and replay

What each Step resolved to (the element's role, name, container and position, and the values) is recorded in
`<file>.cassette.json` next to the feature. On the next run it is replayed without Jev while exactly one element on the
page still matches it.

| `--record` | Behaviour |
|---|---|
| `new` (default) | Replay; resolve new or no-longer-matching Steps live and write them back (reported as *healed*). |
| `none` | Replay only. A missing or broken resolution fails as `UI_CHANGED`. Use in CI. |
| `all` | Resolve everything live and rewrite the cassette. |

The run summary says what happened:

```text
Cassette features/campaign.cassette.json: 2 replayed, 0 recorded, 0 healed
```

## Workflow

1. Record once with `--record new` (or `all`), check the outcomes, commit the cassettes.
2. Run CI with `--record none`: same outcome every run, zero model calls.
3. When the UI really changes, CI fails as `UI_CHANGED`. Heal locally with `--record new` and commit the cassette.

A live run asks Jev every time, so a Step close to the confidence gate can end differently from run to run. Replays
do not. See [Flaky Steps](cookbook.md#flaky-steps).
