Feature: A failing state

  @state:broken
  Scenario: Consumer of a failing state
    Then the session is there

  @state:checkout
  Scenario: Consumer of a nested failing state
    Then the session is there

  Scenario: A plain failing scenario
    When I press checkout
