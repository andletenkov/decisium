@url:http://127.0.0.1:5173/?reset=1
Feature: Memory across steps (checks that refer back to an earlier value)

  Scenario: The scheduled campaign appears in the calendar
    When I start a new campaign
    And I enter "Winter Sale" as the campaign name
    And I set the activation date to "2026-12-01"
    And I save the draft
    And I schedule the campaign
    And I open the calendar
    Then the campaign should appear in the calendar

  # Should FAIL: the draft was never scheduled.
  Scenario: An unscheduled draft does not appear in the calendar
    When I start a new campaign
    And I enter "Summer Sale" as the campaign name
    And I save the draft
    And I open the calendar
    Then the campaign should appear in the calendar

  # No reference to an earlier value: recall must say none, state check still passes.
  Scenario: A check without a reference is unaffected
    When I open the "Spring Sale" campaign
    Then the schedule button should be enabled
