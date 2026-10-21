Feature: DEMOQA (heavy forms, custom widgets, ads)

  @url:https://demoqa.com/automation-practice-form
  Scenario: Submit the student registration form
    When I enter "Ada" as first name and "Lovelace" as last name
    And I enter "ada@example.com" as email
    And I select the gender "Female"
    And I enter "0123456789" as mobile number
    And I tick the hobby "Reading"
    And I submit the form
    Then I should see "Thanks for submitting the form"
    And the submitted student name should be "Ada Lovelace"

  @url:https://demoqa.com/webtables
  Scenario: Add a row to a table and find it by search
    When I open the form to add a record
    And I fill in first name "Grace", last name "Hopper" and email "grace@example.com"
    And I fill in age "45", salary "9000" and department "Navy"
    And I submit the record
    And I search the table for "Hopper"
    Then "grace@example.com" should appear in the table
    And "Cierra" should not appear in the table
