Feature: A saved session that expires

  @state:logged-in
  Scenario: The server drops the session the run saved
    When the server drops this session
    Then the session is there

  @state:logged-in
  Scenario: The next consumer logs in again
    Then the session is there
