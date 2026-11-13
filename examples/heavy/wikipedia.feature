@url:https://en.wikipedia.org/wiki/Ada_Lovelace
Feature: Wikipedia, a long article with a dense sidebar, collapsible contents and hundreds of links

  Scenario: Collapse a section in the contents
    When I collapse the "Biography" subsection in the contents
    Then the "Toggle Biography subsection" button should be collapsed

  Scenario: Jump to a section from the contents
    When I open "Publications" from the contents
    Then the "Publications" heading should be shown

  Scenario: Switch the article to another language
    When I open the languages menu
    # Typing filters the list; the next Step opens the result.
    And I search the languages for "Deutsch"
    And I open the "Deutsch" version
    Then the page heading should be "Ada Lovelace"
    And the URL should contain "de.wikipedia.org"

  @url:https://en.wikipedia.org/wiki/Main_Page
  Scenario: Search from the header
    When I open the "Charles Babbage" article through the search
    Then the page heading should be "Charles Babbage"
