@url:http://127.0.0.1:5173/?reset=1
Feature: Scoped presence probes (every check here should FAIL)

  Scenario: Draft is not in the calendar, toast mentions it
    When I start a new campaign
    And I enter "Summer Sale" as the campaign name
    And I save the draft
    And I open the calendar
    Then "Summer Sale" should appear in the calendar

  Scenario: Detail heading is not the campaign list
    When I open the "Spring Sale" campaign
    Then "Spring Sale" should appear in the campaign list

  Scenario: Draft is not in the scheduled list, toast mentions it
    When I start a new campaign
    And I enter "Summer Sale" as the campaign name
    And I save the draft
    And I open the calendar
    Then "Summer Sale" should be listed among the scheduled campaigns

  # Was a false pass before task 0003: Jev accepted the detail heading as the campaign list.
  Scenario: List check on the detail screen
    When I open the "Spring Sale" campaign
    Then the campaign list should contain "Spring Sale"

  Scenario: "I should see" wording on the detail screen
    When I open the "Spring Sale" campaign
    Then I should see "Spring Sale" in the list of campaigns
