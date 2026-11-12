@url:test/fixtures/realistic/items.html
Feature: A server error echoes a slug of the run's ID (issue #91; #90, problem 3)
  The item name holds {{decisium.runId}}; the error shows it lowercased and joined with hyphens.

  Scenario: Creating the same item twice
    When I create an item named "Item name {{decisium.runId}}"
    Then "Item name {{decisium.runId}}" should appear in the item list
    When I enter "Item name {{decisium.runId}}" as the item name
    And I try to click "Create"
    Then the error should say "already exists"
    And the alert should say "already exists"
    And "already exists" should appear anywhere on the page
