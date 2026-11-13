@url:https://news.ycombinator.com/
Feature: Hacker News, a page of 30 stories with ~10 small links each

  Scenario: Open the newest stories
    When I open "new" in the header
    Then the URL should contain "/newest"

  Scenario: Open the next page
    When I click "More" at the bottom
    Then the URL should contain "p=2"

  Scenario: Open the comments of the first story
    When I open the comments of the first story
    Then the URL should contain "item?id="

  Scenario: Open the profile of a story's author
    When I open the profile of the first story's author
    Then the URL should contain "user?id="
    And "karma:" should appear
