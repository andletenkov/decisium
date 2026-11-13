@url:https://www.ag-grid.com/example/
Feature: AG Grid demo, a virtualised data grid with 1,000 rows, column filters and a toolbar

  Scenario: Filter the grid by language
    When I type "English" in the language filter
    Then every row should show "English" in the Language column

  Scenario: Change the data size
    When I set the data size to "100 Rows, 22 Cols"
    Then the data size should be "100 Rows, 22 Cols"

  Scenario: Change the theme
    When I set the theme to "Alpine"
    Then the theme should be "Alpine"

  Scenario: Select the first row
    When I select the first row
    Then the first row's selection checkbox should be checked
