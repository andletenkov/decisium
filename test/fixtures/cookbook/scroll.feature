@url:test/fixtures/cookbook/index.html?scroll
Feature: Scroll inside lists and panels, and up (task 0061)
  Backs docs/cookbook.md.

  Scenario: A panel that loads more when scrolled down
    When I scroll down the Inbox until "Message 15" is shown
    Then "Message 15" should appear in the Inbox

  Scenario: A chat log that loads older messages when scrolled up
    When I scroll up the Chat until "Chat line 5" is shown
    Then "Chat line 5" should appear in the Chat
