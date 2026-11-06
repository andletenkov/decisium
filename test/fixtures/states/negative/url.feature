Feature: Own url with a state

  @state:logged-in @url:http://example.com
  Scenario: Both
    Then the session is there
