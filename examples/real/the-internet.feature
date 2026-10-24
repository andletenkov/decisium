Feature: The Internet (classic widgets)

  @url:https://the-internet.herokuapp.com/checkboxes
  Scenario: Toggle checkboxes
    When I check checkbox 1
    And I uncheck checkbox 2
    Then checkbox 1 should be checked
    And checkbox 2 should be unchecked

  @url:https://the-internet.herokuapp.com/dropdown
  Scenario: Pick from a dropdown
    When I select "Option 2" in the dropdown
    Then the dropdown should be "Option 2"

  @url:https://the-internet.herokuapp.com/dynamic_loading/2
  Scenario: Content that loads after a delay
    When I load the example until the greeting is shown
    Then I should see "Hello World!"

  @url:https://the-internet.herokuapp.com/login
  Scenario: Wrong password is rejected, right one logs in
    When I try to log in as "tomsmith" with password "wrong"
    Then the message should say "Your password is invalid!"
    When I log in as "tomsmith" with password "SuperSecretPassword!"
    Then the message should say "You logged into a secure area!"

  @url:https://the-internet.herokuapp.com/tables
  Scenario: Sorting a table by a column
    When I sort the first table by last name
    Then the first row of the first table should show "Bach"

  @url:https://the-internet.herokuapp.com/javascript_alerts
  Scenario: A confirm dialog reports the choice
    When I open the JS confirm and cancel it
    Then the result should say "You clicked: Cancel"
