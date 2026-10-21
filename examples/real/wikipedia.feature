@url:https://en.wikipedia.org/wiki/Main_Page
Feature: Wikipedia (real content, search, navigation)

  Scenario: Search opens the article
    When I open the "Ada Lovelace" article through the Wikipedia search
    Then the article title should be "Ada Lovelace"
    And the infobox should show "10 December 1815"

  Scenario: Jump to a section from the contents
    When I open the "Ada Lovelace" article through the Wikipedia search
    And I jump to the "Childhood" section from the contents
    Then the "Childhood" heading should be shown

  Scenario: Read the article in another language
    When I open the "Ada Lovelace" article through the Wikipedia search
    And I switch the article language to Deutsch
    Then the article title should be "Ada Lovelace"
    And I should see "britische Mathematikerin"

  Scenario: The article URL names the article
    When I open the "Ada Lovelace" article through the Wikipedia search
    Then the URL should contain "/wiki/Ada_Lovelace"

  # Should FAIL: still on the search results page.
  Scenario: The search page URL does not name the article
    When I search Wikipedia for "Ada Lovelace computer pioneer" without opening a result
    Then the URL should contain "/wiki/Ada_Lovelace"
