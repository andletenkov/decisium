@url:test/fixtures/realistic/form.html
Feature: An error inside an alert that wraps a generic (issue #91)

  Scenario: A name that is too short
    When I enter "AB" as the project name
    And I try to click "Create project"
    Then the error should say "too short"
    And the alert should say "at least 3 characters"
