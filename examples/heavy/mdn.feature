@url:https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog
Feature: MDN, a reference page with a sidebar tree, a table of contents and a compatibility table

  Scenario: Jump to the compatibility table
    When I open "Browser compatibility" from the "In this article" list
    Then the "Browser compatibility" heading should be shown

  Scenario: Switch the colour theme
    When I open the theme menu
    And I choose the "Dark" theme
    Then the "Dark" option should be selected

  Scenario: Search the docs
    When I search MDN for "fetch"
    And I open the "Window: fetch() method" result
    Then the page heading should be "Window: fetch() method"
