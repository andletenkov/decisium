# State definitions for states.feature (issue 11); the start URL comes from --url.
Feature: Shop states

  @state-def:logged-in @save:storage
  Scenario: Logged in
    When I log in
    Then I am logged in

  @state-def:cart @state:logged-in
  Scenario: A cart with an item
    When I add an item

  @state-def:broken
  Scenario: A state whose check fails
    Then I am logged in
