@url:https://www.saucedemo.com/
Feature: Secret placeholders (task 0030): the credentials come from the environment
  Run with SAUCE_USER=standard_user SAUCE_PASSWORD=secret_sauce (the demo credentials on the login page).

  Scenario: Logging in with credentials from the environment
    When I log in as "$SAUCE_USER" with password "$SAUCE_PASSWORD"
    Then the page heading should say "Products"
