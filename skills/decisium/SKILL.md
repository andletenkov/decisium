---
name: decisium
description: Design, write or repair Decisium Gherkin features (natural-language Steps run by Jev). Use when generating test scenarios from app code or requirements, writing a .feature for Decisium, or when a Step ends AMBIGUOUS, UNVERIFIABLE or STEP_TIMEOUT.
---

Decisium runs each Step by asking Jev, a decision model that only picks among offered answers; code decides pass/fail.
A Step's wording decides most outcomes. The wording rules, per kind of Step, are in
https://andletenkov.github.io/decisium/steps.html. Read it before writing a Step. This skill is the procedure.

## Design (when generating from app code or requirements)

Skip this when the user already gave the scenarios. App logic first, input fields last: a suite of form-validation
cases that never completes a real journey is a failed design.

1. Map critical user journeys (CUJs). From requirements and code (routes, handlers, domain services, models), list
   the end-to-end goals users come for (sign up → first value, search → buy → order confirmed, create → share →
   collaborator sees it). Rank by business impact × usage × how badly a break hurts (money, data loss, lock-out).
   Note the source (`file:line` or requirement id) of each.
2. Cover each CUJ with app logic before inputs:
   - **Happy path end to end**, checking the business outcome (order exists with the right total, item visible to
     the other role), not just "a success message".
   - **Business rules and variants** that change the outcome: roles and permissions, plan/limit tiers, pricing,
     discounts, ownership. Use a **decision table** (one case per distinct outcome, not every combo).
   - **State transitions** of the domain objects the journey moves (draft → published, cart → order → refunded):
     each allowed transition, plus one disallowed one per state that the UI can attempt.
   - **Journey breaks**: abandon and resume, reload/back mid-flow, duplicate submit, already-used values, session
     expiry, permission denied.
3. Only then, input fields on the CUJ path: **equivalence classes** (one valid + one per distinct invalid class) and
   **boundary values** (at, just below, just above each limit found in code, e.g. `min(8)` → 7, 8 chars). Skip fields
   off the critical journeys unless asked.
4. Prioritise in that order: CUJ happy paths, business rules and states, journey breaks, then inputs. Drop cases
   the UI cannot observe (pure backend, timing) and say so.
5. Decide automate or not, per case. Automate when the value (CUJ, risk, how often it runs) beats the cost:
   - **Setup**: can the precondition be reached through the UI or a seeded account in a few Steps? Needing a
     specific DB state, a past date, a paid plan, an admin action or a third party (payment, email/SMS code, OAuth,
     captcha) is a cost; prefer a test account or sandbox that already holds it.
   - **Cleanup / repeatability**: does the run leave data that breaks the next run (unique email taken, stock used,
     item already published)? Use unique values per run or a self-cleaning flow; irreversible side effects (real
     payment, real email to customers, deleting shared data) mean do not automate against that environment.
   - **Determinism**: time, randomness, async jobs, rate limits, A/B flags → flaky unless controllable.
   - **Observability**: the outcome must show in the UI; otherwise it is not a Decisium case.
   Mark each case `automate`, `automate later (needs: …)` or `manual (why)`. Write only `automate` cases; list the
   rest with what would unblock them. Tag Scenarios needing special setup (e.g. `@needs-seed-admin`).
6. Shape: one behaviour per Scenario, named by its expected outcome. Same flow with different data → a
   `Scenario Outline` with `Examples` (one row per class/boundary). Each Scenario is independent (fresh browser), so
   repeat setup Steps or use `Background`. Every Scenario ends with a check of the observable outcome (message text,
   value, page), never just an action. Use only data the app accepts or rejects deterministically.
7. Show the user the CUJ list and case list (journey, behaviour, technique, source, automate decision) before
   writing, if long or requirements were ambiguous.

## Write

1. Write the feature: an `@url:<start url>` tag, then one Scenario per user journey, each starting from a fresh browser.
   Word each Step like a **Write** row of its kind (navigate, type, select, act, attempt, keys, value / presence /
   scoped / state check, memory, secrets). Quote every value the Step uses and every value a check compares.
   Credentials go in as `"$NAME"` placeholders, with the variables set in the environment or `.env`.
2. Run `decisium lint <file.feature>`. It shows how each Step will be read (kind, quoted values, placeholders) and
   flags wordings to avoid with ⚠. Done when every ⚠ is reworded away, or kept on purpose with a `#` comment saying why.

## Run and repair

3. Run `decisium run <file.feature>` (live Jev the first time; it records a cassette next to the feature).
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
