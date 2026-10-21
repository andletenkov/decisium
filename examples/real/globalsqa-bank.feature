@url:https://www.globalsqa.com/angularJs-protractor/BankingProject/#/login
Feature: XYZ Bank (AngularJS, business rules)

  Background:
    When I log in as customer "Harry Potter"

  Scenario: Deposit increases the balance
    When I deposit 500
    Then the message should say "Deposit Successful"
    And the balance should be "500"

  Scenario: Withdrawing more than the balance fails
    When I try to withdraw 100
    Then the message should say "Transaction Failed. You can not withdraw amount more than the balance."
    And the balance should be "0"
