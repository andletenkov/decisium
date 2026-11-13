@url:https://github.com/microsoft/playwright
Feature: GitHub, a real site (public pages, no login)
  Live site: cassettes replay while the recorded controls still match; changed ones heal with `--record new`.

  Scenario: Find the latest release of a repository
    When I open the releases page
    Then the page heading should be "Releases"
    And a release marked "Latest" should be shown

  Scenario: Browse issues and search them
    When I open the Issues tab
    Then the "Issues" tab should be selected
    When I search the issues for "screenshot" and submit the search
    Then "screenshot" should appear in the issue list

  Scenario: Read a file from the repository
    When I open the "package.json" file
    Then the file content should contain "playwright-internal"
    And the "Raw" link should be enabled

  @url:https://github.com/
  Scenario: Search for a repository and open it
    When I search GitHub for "microsoft/playwright"
    And I open the "microsoft/playwright" repository from the results
    Then the repository name "playwright" should be shown
