@url:https://marmelab.com/react-admin-demo/
Feature: react-admin demo, an admin panel with a menu, data grids, filters and bulk actions
  The demo data is generated on each load, so checks quote the app's labels, not record values.

  # "demo"/"demo" is the public demo login printed on the sign-in page, not a secret.
  Background:
    Given I log in as "demo" with password "demo"

  Scenario: Open the orders and switch the status tab
    When I open "Orders" from the menu
    And I open the "Delivered" tab
    Then the "Delivered" tab should be selected

  Scenario: Filter customers by a search
    When I open "Customers" from the menu
    And I search the customers for "zzzz-no-such-customer" and submit the search
    Then "No Customers found" should appear

  Scenario: Open a product category
    When I open "Categories" from the menu
    And I open the "Animals" category
    Then the name field should be "Animals"

  Scenario: Switch the interface to dark mode
    When I switch to the dark theme
    Then the "Toggle light/dark mode" button should be shown
