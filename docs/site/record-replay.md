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
do not. See [Troubleshooting](troubleshooting.md). Backend requests can be replayed too: [Network replay](network-replay.md).

## Pin an ambiguous target

When an action fails because Jev is unsure which element to use, the failure report lists up to three **Resolutions**
(role, name, container and any disambiguating text/position), each followed by its ready-to-copy pin command:

```text
2. button "Search" in region "Products" (35%)
   decisium pin 'features/campaign.feature:12' 2
```

Inspect the screenshot, then copy the command under the correct candidate—no feature-file lookup or number editing
needed. Replay afterward:

```sh
decisium pin features/campaign.feature:12 2
decisium run features/campaign.feature --record none
```

No `TYPESAFE_API_KEY`, browser or rewording is needed to pin. The number is the Resolution's 1-based report index.
The cassette keeps a `pinned` marker with the chosen Resolution, candidate number, turn and original probabilities;
review and commit the diff. Replay still requires that Resolution to match exactly one element.

Pin supports **explicit single-action Steps** starting with `I click`, `I double-click`, `I right-click`, `I hover over`,
`I type`, `I fill`, `I select` or `I upload` (the `I` is optional). Targets must be quoted names (optionally followed by
`button`, `field`, etc.) or control nouns such as `a button` or `the field`; an optional `in "Area"` scopes them.
Examples: `I click the "Save" button`, `I type "Ada" into the "Name" field`.
Only these bounded single-action forms are accepted. Other wording, compound Steps and unresolved continuations are
rejected rather than inventing a model completion. The browser must execute the confirmed action successfully;
later assertion Steps still check the result. Pin never makes a failed assertion pass.

For typing/selecting/uploading, an existing recorded value is preserved. If none was recorded, pin accepts only an
explicit quoted value: `I type "Ada" into …`, `I fill … with "Ada"`, `I select "Weekly" from …`, or
`I upload "file.txt" to …`. Container names are never inferred as values; otherwise reword and record instead.
The explicit action must be compatible with the selected control. Checks, dialog choices, drag destinations,
action-table rows, and lines shared by multiple Background/Outline instances are not pinnable.
Older cassettes may have fewer than three candidates. Only recorded candidates can be selected.
`--record all` replaces pins along with the rest of the recording; healing a changed Step replaces its pin too.

## Waiting on replay

A replay waits the way a Playwright spec does, not after every action:

- An action does not wait for the page to settle. The next action waits until its recorded element is on the page.
- A check retries until it passes or the page has nothing left pending (up to 5 s).
- An action that shows no change yet waits for one before it counts as having done nothing.
- A request pending for over 1.5 s (a hung analytics or error-report call) stops counting as pending.

A live run (`--record new` or `all`) also waits after each action for the requests it started (up to 5 s), so Jev
sees the result.
