@url:test/fixtures/cookbook/index.html?frames
Feature: iframes and open shadow roots (task 0047)
  Backs docs/cookbook.md.

  Scenario: A form inside an iframe
    When I enter "ada@example.com" in Email
    And I click Subscribe
    Then the newsletter status should be "Subscribed ada@example.com"
    And the Email field should be "ada@example.com"

  Scenario: A button inside a web component
    When I click Like
    Then the Like button should be pressed
    And "1 like" should be shown
