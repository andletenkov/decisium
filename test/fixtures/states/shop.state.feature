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

  @state-def:checkout @state:logged-in
  Scenario: A checkout whose button fails, nested on a login
    When I press checkout

  @state-def:jev @state:logged-in
  Scenario: A state Step for Jev, which has no recording
    When I open the dashboard

  @state-def:stringly
  Scenario: A client step that throws a string
    When I throw a string
