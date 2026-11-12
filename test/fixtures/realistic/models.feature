@url:test/fixtures/realistic/models.html
Feature: A combobox filled only after another field changes (issue #91; #90, problem 2)

  Scenario: Pick a model after the provider
    When I select "Northwind AI" as the provider
    And I pick "Option A" as the model
    Then "Model: Option A" should appear in the summary
