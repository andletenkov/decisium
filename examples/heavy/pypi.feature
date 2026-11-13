@url:https://pypi.org/project/requests/
Feature: PyPI, a project page with a long readme, side navigation and release history

  Scenario: Open the release history
    When I open "Release history" in the navigation
    Then "Release history" should appear as a heading

  Scenario: Open the download files
    When I open "Release files" in the navigation
    Then "Source Distribution" should appear

  Scenario: Search for another project
    When I search PyPI for "httpx"
    And I open the "httpx" result
    Then the page heading should contain "httpx"
