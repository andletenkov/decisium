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

  Scenario: Login with wrong credentials is rejected
    When I open "login"
    # A made-up account on purpose: the check is the rejection.
    And I try to log in as "decisium-nobody" with password "wrong-password"
    Then "Bad login." should appear
