@url:examples/cookbook/index.html?dialogs
Feature: Browser dialogs (task 0040)
  Backs docs/cookbook.md. Scenarios marked "Should FAIL" show a wording the cookbook warns against.

  Scenario: Confirm a deletion
    When I delete the "Groceries" note
    Then "Groceries" should not appear in the notes
    And the confirm should say "Delete the Groceries note?"

  Scenario: Cancel a confirm
    When I start deleting the "Ideas" note but cancel
    Then "Ideas" should still appear in the notes list

  Scenario: Read an alert
    When I save the settings
    Then the alert should say "Settings saved"

  Scenario: Answer a prompt
    When I rename the list to "Errands"
    Then the list heading should be "Errands"

  Scenario: Leave a page with unsaved changes
    When I write "half done" as the draft
    And I leave for the search page
    Then the page heading should be "Search"

  # Should FAIL: the Step that opened the confirm already answered it; nothing is open any more.
  Scenario: A Step that only answers the dialog
    When I click the delete button of "Groceries"
    And I accept the confirm
    Then "Groceries" should not appear in the notes
