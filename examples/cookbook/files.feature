@url:examples/cookbook/index.html?files
Feature: File upload and download (task 0044)
  Backs docs/cookbook.md.

  Scenario: Upload through a hidden file input
    When I upload "notes.txt" with the Attach file button
    Then the status should be "Attached notes.txt"

  Scenario: Download a CSV
    When I export the contacts as CSV
    Then the downloaded file name should be "contacts.csv"
    And the downloaded file should contain "Ada Lovelace,engineer"
