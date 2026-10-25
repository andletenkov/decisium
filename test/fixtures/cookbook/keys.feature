@url:test/fixtures/cookbook/index.html?keys
Feature: Keys (task 0039)
  Backs docs/cookbook.md. Scenarios marked "Should FAIL" show a wording the cookbook warns against.

  Scenario: Close a dialog with Escape
    When I open the keyboard help
    Then "Close it with Escape." should appear
    When I press Escape
    Then "Close it with Escape." should not appear

  Scenario: Open the command palette with a shortcut
    When I open the command palette by pressing Ctrl+K
    Then "Go to settings" should appear in the command palette

  Scenario: Move through a list with the arrow keys
    When I press the down arrow
    Then "Banana" should be selected
    And "Apple" should be unselected

  Scenario: Move the focus with Tab
    When I press "Tab"
    Then the status should be "Focus: Note"

  # Should FAIL: without "press" or "hit" no key is offered, and the help has no button to close it.
  Scenario: A key named without press
    When I open the keyboard help
    And I close the help with the Escape key
    Then "Close it with Escape." should not appear
