Feature: An unknown state

  @state:nope
  Scenario: Uses a state nobody defined
    Then the session is there
