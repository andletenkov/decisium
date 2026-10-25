@url:http://127.0.0.1:5173/?reset=1
Feature: Campaign manager (multi-screen; start with `npm run example:server`)

  @QaseID=76
  Scenario: Create, schedule and find a campaign in the calendar
    When I start a new campaign
    And I enter "Winter Sale" as the campaign name
    And I set the activation date to "2026-12-01"
    And I set the activation period to 2 weeks
    And I save the draft
    Then the campaign status should be "Draft"
    When I schedule the campaign
    Then the campaign status should be "Scheduled"
    And the "Schedule" button should be disabled
    When I open the calendar
    Then "Winter Sale" should appear in the calendar

  @QaseID=77
  Scenario: Scheduling needs an activation date
    When I open the "Spring Sale" campaign
    And I try to schedule the campaign
    Then the error should say "Set an activation date before scheduling"
    And the campaign status should be "Draft"

  # The toast still mentions "Spring Sale"; the check is scoped to the list (task 0003).
  @QaseID=78
  Scenario: Delete a campaign from its actions menu
    When I open the "Spring Sale" campaign
    And I delete the campaign
    Then "Spring Sale" should not appear in the campaign list
