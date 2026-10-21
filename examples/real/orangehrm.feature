@url:https://opensource-demo.orangehrmlive.com/web/index.php/auth/login
Feature: OrangeHRM demo (enterprise SPA, filters)
  Demo credentials are shown on the login page.

  Scenario: Invalid credentials are rejected
    When I try to log in as "Admin" with password "wrong-password"
    Then the error should say "Invalid credentials"

  Scenario: Filter system users by role
    When I log in as "Admin" with password "admin123"
    And I open the Admin section
    And I filter the users by user role "Admin"
    And I search
    Then every listed user should have the role "Admin"

  Scenario: The dashboard shows after login
    When I log in as "Admin" with password "admin123"
    Then the page heading should be "Dashboard"
