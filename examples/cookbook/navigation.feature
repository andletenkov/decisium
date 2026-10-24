@url:examples/cookbook/index.html?nav
Feature: Navigation and tabs (task 0041)
  Backs docs/cookbook.md.

  Scenario: Go to a page by its path
    When I go to "?keys"
    Then the heading should be "Keys"

  Scenario: Go back
    When I open the Keys page
    And I go back
    Then the heading should be "Navigation"

  Scenario: Go back in your own words
    When I open the Keys page
    And I return to the previous page
    Then the heading should be "Navigation"

  Scenario: Reload the page
    Then the status should be "Loaded 1 time"
    When I reload the page
    Then the status should be "Loaded 2 times"

  Scenario: A link that opens a new tab
    When I open the contacts
    Then the heading should be "Contacts"
    When I close the tab
    Then the heading should be "Navigation"
