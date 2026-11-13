Feature: DemoQA, widget-heavy pages with ads, a side menu and a paginated table

  @url:https://demoqa.com/webtables
  Scenario: Add a row to the web table
    When I click "Add"
    And I enter "Ada" as first name, "Lovelace" as last name, "ada@example.com" as email, "36" as age, "5000" as salary and "Math" as department
    And I submit the registration form
    Then "ada@example.com" should appear in the table

  @url:https://demoqa.com/webtables
  Scenario: Search the web table
    # The table filters as you type: typing is the whole action.
    When I search the table for "Cantrell"
    Then "alden@example.com" should appear in the table
    And "cierra@example.com" should not appear in the table

  @url:https://demoqa.com/webtables
  Scenario: Delete a row
    When I delete the row of "Kierra"
    Then "kierra@example.com" should not appear in the table

  @url:https://demoqa.com/automation-practice-form
  Scenario: Fill the student registration form
    When I enter "Ada" as first name and "Lovelace" as last name
    And I choose "Female" as gender
    And I enter "0123456789" as mobile number
    And I tick the "Reading" hobby
    And I submit the form
    Then the dialog should say "Thanks for submitting the form"
    And "Ada Lovelace" should appear in the dialog
