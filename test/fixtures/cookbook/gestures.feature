@url:test/fixtures/cookbook/index.html?gestures
Feature: Double-click, right-click, drag and drop, sliders (task 0045)
  Backs docs/cookbook.md.

  Scenario: Edit a title inline
    When I double-click the note title and change it to "Groceries"
    Then the status should be "Title: Groceries"

  Scenario: A custom context menu
    When I right-click report.pdf and choose "Delete"
    Then the status should be "Delete report.pdf"

  Scenario: Move a list item to another list
    When I drag "Fix bug" to the Done list
    Then "Fix bug" should appear in the Done list
    And "Fix bug" should not appear in the To do list

  Scenario: A slider
    When I set the volume to "75"
    Then the status should be "Volume 75"
