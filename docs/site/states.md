# States

A state is a reusable precondition written as Steps: logged in, a cookie banner dismissed, a cart with items. Define it
once with `@state-def:<name>` and start any scenario from it with `@state:<name>`.

Definitions live in `*.state.feature` files next to your features. Decisium finds every `**/*.state.feature` under the
working directory (not `node_modules`, `dist`, `build`, `runs`), whichever features you run; set
`worldParameters.decisium.states` (or `DECISIUM_STATES`) to another glob. `decisium run` never runs a definition file as
a test, even when a broad glob names it. Raw `cucumber-js` stops with "is a state definition file; exclude it from
test paths".

```gherkin
# features/shop.state.feature
@url:https://shop.example.com
Feature: Shop states

  # Saved once per run, loaded into later consumers.
  @state-def:logged-in @save:storage
  Scenario: Logged in as an admin
    When I log in as "$USERNAME" with password "$PASSWORD"
    Then the header should show "Admin"

  # Page state: always replayed.
  @state-def:consent-dismissed
  Scenario: Cookie banner dismissed
    When I click "Accept all"
    Then the "Cookie settings" banner should not be shown

  # Chain: starts from logged-in, then replays its own Steps.
  @state-def:cart-with-items @state:logged-in
  Scenario: A cart with three items
    When I add the "Backpack" to the cart
    And I add the "Bike light" to the cart
    And I add the "T-shirt" to the cart
    Then the cart badge should show "3"
```

```gherkin
@state:cart-with-items
Scenario: Checkout shows the right total
  When I open the checkout
  Then the order total should be "59.97"
```

**Start URL:** the `@url:` of the first state in the chain (`--url` overrides). The scenario continues on the page the
state ended on; go elsewhere with a Step such as `I go to "/checkout"`. A scenario's own `@url:` together with `@state:` is
an error.

**Each scenario gets a fresh browser**, and its `@viewport:`, `@locale:`, `@timezone:`, `@geolocation:` apply to the
state's Steps too. A state's Steps are recorded in the consuming feature's cassette, keyed `state:<name>: <Step>`. A
line one of your [client step definitions](client-steps.md) matches runs it.

**`@save:storage`:** after this state's Steps run, its cookies and `localStorage` are saved and loaded into the
scenarios that use it, for the rest of the run. Page state and `sessionStorage` are not saved; end the definition with a
`Then` check. The first scenario that reaches the state replays its Steps and saves; parallel workers wait for it
instead of all logging in. Later scenarios load the storage, re-run the final check and skip the other Steps; if the
check fails, the Steps are replayed. Values the skipped Steps named are not remembered for later Steps. The storage lives
in a temporary directory outside the project (owner-only, files `0600`), keeps only the start URL's origin, and is deleted
when the run ends. A scenario that loaded one keeps no Playwright trace (it would hold the session cookies).

**A state is setup, not a test.** A failing state Step stops the run as a setup error (exit 2), labelled
`in state "<name>" at <file>:<line>`. Test the login itself in a normal feature.

**Checked before any browser opens:** unknown state names, cycles, duplicate names, `@state-def:` or `@state:` on a
Feature, a `Background:` in a definition file, more than one `@state:` on a scenario, `@save:storage` without a final
`Then`, `@replay-network` on a scenario whose state types a secret (it would record it into the HAR file), and tags one
typo away from a Decisium tag (`@stat:` → "did you mean @state:?"). `@state-def:` on a scenario in a normal feature defines nothing: Decisium warns and runs it as a test.
