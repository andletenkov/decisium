@url:https://demo.playwright.dev/todomvc/
Feature: TodoMVC (list state, counters, filters)

  Background:
    When I add a todo "Buy milk"
    And I add a todo "Write report"
    And I add a todo "Call mom"

  Scenario: Completing a todo updates the counter
    When I mark "Write report" as completed
    Then the counter should say "2 items left"
    And "Write report" should be checked

  Scenario: Filters show only matching todos
    When I mark "Buy milk" as completed
    And I show only the active todos
    Then "Buy milk" should not appear in the todo list
    And "Call mom" should appear in the todo list

  Scenario: Clearing completed todos removes them
    When I mark all todos as complete
    And I clear the completed todos
    Then "Buy milk" should not appear in the todo list
    And the todo list should be empty
