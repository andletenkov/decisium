Feature: A state definition in a test

  @state-def:misplaced @state:logged-in
  Scenario: Defined in a test file
    Then the session is there
