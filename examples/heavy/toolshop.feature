@url:https://practicesoftwaretesting.com/
Feature: Toolshop, a shop with a filter sidebar, a price slider, sorting and a product grid

  Scenario: Filter products by category
    When I tick the "Hammer" category
    Then "Claw Hammer" should appear in the product list
    And "Combination Pliers" should not appear in the product list

  Scenario: Sort products by price
    When I sort the products by "Price (High - Low)"
    Then the sort should be "Price (High - Low)"

  Scenario: Search for a product
    When I search the products for "pliers" and submit the search
    Then "Long Nose Pliers" should appear in the product list
    And "Claw Hammer" should not appear in the product list

  Scenario: Add a product to the cart
    When I open the "Combination Pliers" product
    And I add it to the cart
    Then the cart should show "1"
