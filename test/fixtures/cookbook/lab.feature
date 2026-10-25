@url:test/fixtures/cookbook/index.html
Feature: Cookbook lab (task 0031): wordings that work, and wordings that do not, on one small page
  Backs docs/cookbook.md. Scenarios marked "Should FAIL" show a wording the cookbook warns against.

  Scenario: Open an article through the search
    When I open the "Ada Lovelace" article through the search
    Then the article heading should be "Ada Lovelace"
    And the article should say "born 10 December 1815"

  # Should FAIL: "title" also names the browser tab's title ("Cookbook lab").
  Scenario: A check on the article title
    When I open the "Ada Lovelace" article through the search
    Then the article title should be "Ada Lovelace"

  # Should FAIL: "search for" types and submits; nothing opens a result.
  Scenario: Searching does not open the article
    When I search for "Ada Lovelace"
    Then the article heading should be "Ada Lovelace"

  Scenario: Results are checked by quoting what should be listed
    When I search for "Ada" and submit the search
    Then "Ada (programming language)" should appear in the results
    And "Charles Babbage" should not appear in the results

  # Should FAIL: the check quotes nothing for code to look for.
  Scenario: A check that quotes nothing
    When I search for "Ada" and submit the search
    Then the results should be shown

  # Should FAIL: a value check compares one quoted value.
  Scenario: A value check with two values
    When I open the "Ada Lovelace" article through the search
    Then the article title should be "Ada" or "Ada Lovelace"

  # Should FAIL: a subjective check without --judged.
  Scenario: A subjective check
    When I open the "Ada Lovelace" article through the search
    Then the article should be well written

  @url:test/fixtures/cookbook/index.html?settings
  Scenario: Uncheck a labelled checkbox
    When I uncheck "Newsletter"
    Then "Newsletter" should be unchecked
    And "Weekly digest" should be unchecked

  @url:test/fixtures/cookbook/index.html?settings
  Scenario: Check a labelled checkbox
    When I check "Weekly digest"
    Then "Weekly digest" should be checked
