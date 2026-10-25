@url:test/fixtures/cookbook/index.html?hover
Feature: Hover (task 0042)
  Backs docs/cookbook.md.

  Scenario: A menu that opens only on mouse-over
    When I open the Products menu
    And I choose "Pricing" in it
    Then the status should be "Opened Pricing"

  Scenario: A tooltip shown on hover
    When I hover over the help button
    Then the tooltip should say "Opens the docs"

  Scenario: A title attribute
    Then the Save button's tooltip should be "Save your work"
