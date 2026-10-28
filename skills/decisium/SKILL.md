---
name: decisium
description: Write or repair Decisium Gherkin features (natural-language Steps run by Jev). Use when writing a .feature for Decisium, or when a Step ends AMBIGUOUS, UNVERIFIABLE or STEP_TIMEOUT.
---

Decisium runs each Step by asking Jev, a decision model that only picks among offered answers; code decides pass/fail.
A Step's wording decides most outcomes. The wording rules, per kind of Step, are in
https://andletenkov.github.io/decisium/steps.html. Read it before writing a Step. This skill is the procedure.

## Write

1. Write the feature: an `@url:<start url>` tag, then one Scenario per user journey, each starting from a fresh browser.
   Word each Step like a **Write** row of its kind (navigate, type, select, act, attempt, keys, value / presence /
   scoped / state check, memory, secrets). Quote every value the Step uses and every value a check compares.
   Credentials go in as `"$NAME"` placeholders, with the variables set in the environment or `.env`.
2. Run `npx decisium lint <file.feature>`. It shows how each Step will be read (kind, quoted values, placeholders) and
   flags wordings to avoid with ⚠. Done when every ⚠ is reworded away, or kept on purpose with a `#` comment saying why.

## Run and repair

3. Run `npx decisium run <file.feature>` (live Jev the first time; it records a cassette next to the feature).
4. On a failure, read `runs/<id>/report.md`: the Step at `file:line`, Jev's answers, the page text around the element,
   and a rerun command for that scenario. Classify each failure:
   - **The app is wrong** (ASSERTION_FAILED, BLOCKED with the expected control truly missing): keep the Step, and
     report the app behaviour.
   - **The wording is unclear** (AMBIGUOUS, UNVERIFIABLE, a check that picked the wrong element): reword using
     https://andletenkov.github.io/decisium/troubleshooting.html, then rerun just that scenario.
   - **`AMBIGUOUS: Jev chose … which is not "X"`** usually means the Step before already used X (it finished the task):
     merge the two Steps, not an app bug.
   - A **marginal pass** warning means the pass rested on a barely-confident answer. Treat it like an unclear wording.
5. Keep the test's intent fixed while rewording. The quoted expected values and the area a check looks in stay as
   written. A rewording that makes a check pass by reading a different element (a link instead of the heading, a
   search box instead of the article) is a false pass. Compare Jev's subject in `report.md` with what the scenario
   means.

Done when the run passes, or every remaining failure is classified as the app being wrong, with the evidence line from
`report.md`.
