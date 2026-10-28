# How a Step runs

Decisium reads the page, lists what is on it, and asks **Jev** questions whose answers are picks among that list. Jev
never writes code or values; every answer comes back as a probability per option. Decisium's code then checks the
confidence, performs the action with Playwright and decides pass or fail.

A question is asked in a **request**: one call to Jev carrying the Step's text, a text snapshot of the page (`ui`) and
one or more questions. Questions in the same request read the same page, so their answers are consistent.

## An action Step

An action Step runs in **Turns**. Each Turn is one request with three questions:

| Question | Options | Answer used for |
|---|---|---|
| Given the actions taken for the Step so far, does `ui` show the Step is fully accomplished? | yes/no, as a probability | ending the Step |
| Which element in `ui` should be interacted with next? | every actionable element, plus "the page itself" and "none" | the target |
| How should that element be used? | click, type, select, hover, press a key, scroll… | the action |

Then code decides, in this order:

1. **Done?** `done ≥ 0.8` ends the Step. After an action that changed the page, `done ≥ 0.5` with target "none" is
   enough.
2. **Sure of the target?** The top element needs ≥ 0.5 and a lead of ≥ 0.1 over the next; otherwise `AMBIGUOUS`. Target
   "none" is `BLOCKED`.
3. **The right control?** A click on a lookalike of a quoted control ("Publish again" when the Step quotes "Publish
   now") is `AMBIGUOUS`, and nothing is clicked.
4. **Act.** Playwright performs it, waits for the requests it started, and the next Turn reads the new page.

A Step gets at most 8 Turns (`STEP_TIMEOUT`). Some actions add one request:

| When | Extra question |
|---|---|
| The action types, selects or uploads | Which value should be entered into the element? Options: the Step's quoted values, numbers and Doc string, plus "none". |
| A browser dialog is open | How should it be answered? Options: OK / Cancel, or one of the quoted values for a prompt. |
| The action is a drag | Onto which element should it be dropped? |

`I press Escape`, `I go back`, `I go to "/settings"` ask nothing: code does them directly.

### Example

From a live run of `When I delete the campaign` in the demo app (`npm run example:server`,
`test/fixtures/campaign-manager`):

| Turn | Page | done | target | Code |
|---|---|---|---|---|
| 1 | Campaign page | 0.04 | button "More actions" 0.99 | click "More actions" |
| 2 | Menu open: "Delete campaign" | 0.03 | menuitem "Delete campaign" 1.00 | click "Delete campaign" |
| 3 | Campaign list, toast "deleted" | 0.98 | none 0.86 | `DONE` |

3 requests. `done` stayed low with the menu open because nothing was deleted yet: a Step continues until its task is
done, so a following `I click "Delete campaign"` would have nothing left to do.

## A check

A check is one request with four questions; Jev only says *what* to look at, code compares:

| Question | Options |
|---|---|
| What kind of check is it? | value, presence, absence, state, fuzzy |
| Which element is the check about? | every element with text, plus "none" |
| Which control state does it require? | checked, disabled, expanded, selected… |
| Where does it say to look? | the page's lists, tables, sections, dialogs; "anywhere" or "named area missing" |

Code then reads the element and compares it with the quoted value. A check that does not pass yet is asked again each
time the page changes, up to 5 s: one more request per change. A check that quotes nothing first asks which value from
an earlier Step it refers to (one more request). A [judged check](steps.md#judged-checks) adds a fifth question: does
`ui` satisfy the check?

## Large pages

- **More than 255 candidates** (a choice question's limit): they are asked in batches, the top 3 of each batch are kept,
  and the real question is asked over what is left. A page with 336 links costs 2 more requests.
- **A snapshot over about 80,000 characters**: it is cut into sections and Jev picks the sections the Step needs, before
  the questions above. More requests, once per Step and page.

## How many requests

Typical counts:

| Step | Requests |
|---|---|
| Action done in one click | 2 (act, then confirm done) |
| Action through a menu or dialog | 3 or more |
| Type into a field | + 1 per value typed |
| Check that passes at once | 1 |

The demo app's first scenario (create, schedule and find a campaign; 11 Steps), run live: **21 requests**, about 24,000
input and 4,400 output tokens. Each typed or selected value took 3 (act, value, done).

Replays (`--record none`) send no request: the cassette holds each Step's answers. See
[Record and replay](record-replay.md).

## Where to see it

- `log.txt` in the run directory: every Turn's page, `Decision: done=… action: … target: …` and what was executed.
- `trace.jsonl`: per Step `jevCalls`, `inputTokens` and `outputTokens`.
- `report.md`: for a failed Step, Jev's answers with the top three options each.
