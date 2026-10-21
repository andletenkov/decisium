@url:https://en.wikipedia.org/wiki/Main_Page
Feature: Wikipedia (real content, search, navigation)

  Scenario: Search opens the article
    When I search Wikipedia for "Ada Lovelace"
    Then the article title should be "Ada Lovelace"
    And the infobox should show "10 December 1815"

  Scenario: Jump to a section from the contents
    When I search Wikipedia for "Ada Lovelace"
    And I jump to the "Early life" section from the contents
    Then the "Early life" heading should be shown

  Scenario: Read the article in another language
    When I search Wikipedia for "Ada Lovelace"
    And I switch the article language to Deutsch
    Then the article title should be "Ada Lovelace"
    And I should see "englische Mathematikerin"
