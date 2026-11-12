@url:test/fixtures/realistic/shell.html
Feature: A check with no named area on a large app screen (issue #91; #90, problem 1)
  About 100 KB of HTML with a sidebar, a tablist, a toolbar, 100 rows and nested wrappers: the area answer spreads
  over page, main, group and generic nodes. A check that names no area reads the whole page.

  Scenario: Save the current view
    When I click "Save view"
    Then "View saved" should appear
