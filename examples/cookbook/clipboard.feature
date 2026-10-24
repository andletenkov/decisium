@url:examples/cookbook/index.html?clipboard
Feature: Clipboard (task 0062)
  Backs docs/cookbook.md.

  Scenario: Copy an invite link and paste it
    When I copy the invite link
    Then the copied text should be "https://example.com/invite/7f3a"
    When I paste into the message box
    Then the message box should show "https://example.com/invite/7f3a"
