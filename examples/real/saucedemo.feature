@url:https://www.saucedemo.com/
Feature: Sauce Demo shop (login, sorting, cart, checkout validation)
  Demo credentials are listed on the login page.

  Scenario: A locked out user cannot log in
    When I log in as "locked_out_user" with password "secret_sauce"
    Then the error should say "Sorry, this user has been locked out."

  Scenario: Sorting by price puts the cheapest product first
    When I log in as "standard_user" with password "secret_sauce"
    And I sort the products by "Price (low to high)"
    Then the first product price should be "$7.99"

  Scenario: The cart counts added products
    When I log in as "standard_user" with password "secret_sauce"
    And I add "Sauce Labs Backpack" to the cart
    And I add "Sauce Labs Bike Light" to the cart
    Then the cart badge should show "2"

  Scenario: Checkout requires a first name, then completes
    When I log in as "standard_user" with password "secret_sauce"
    And I add "Sauce Labs Backpack" to the cart
    And I open the cart
    And I start the checkout
    And I try to continue without filling in the form
    Then the error should say "First Name is required"
    When I enter "Ada" as first name, "Lovelace" as last name and "10115" as postal code
    And I continue
    Then the item total should be "$29.99"
    When I finish the order
    Then I should see "Thank you for your order!"
