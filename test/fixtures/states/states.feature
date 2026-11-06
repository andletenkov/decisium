Feature: Scenarios starting from states

  @state:logged-in
  Scenario: First consumer logs in and saves the storage
    Then the session is there

  @state:logged-in
  Scenario: Second consumer loads the saved storage
    Then the session is there

  @state:cart
  Scenario: Chained state replays only its own Steps
    Then the session is there
