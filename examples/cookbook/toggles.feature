@url:examples/cookbook/index.html?toggles
Feature: Radios and toggles without check words (task 0043)
  Backs docs/cookbook.md.

  Scenario: Accept, turn off, choose, already on
    When I accept the terms
    And I turn off dark mode
    And I choose Express shipping
    And I subscribe to the newsletter
    Then the terms checkbox should be checked
    And the Dark mode switch should not be checked
    And the Express radio should be checked
    And the newsletter checkbox should be checked
