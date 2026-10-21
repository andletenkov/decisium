@url:https://ecommerce-playground.lambdatest.io/
Feature: LambdaTest e-commerce playground (search, product, cart)

  Scenario: Search finds a product and adds it to the cart
    When I search the store for "iPhone"
    And I open the "iPhone" product from the results
    And I add it to the cart
    Then I should see "Success: You have added iPhone to your shopping cart!"

  Scenario: A search with no matches says so
    When I search the store for "zzzz-no-such-product"
    Then I should see "There is no product that matches the search criteria."
