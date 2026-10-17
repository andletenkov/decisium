@url:examples/campaign-app/index.html
Feature: Campaign form (single screen)

  Scenario: Schedule a campaign
    When I enter "Autumn Sale" as the campaign name
    And I set the activation period to 2 weeks
    And I schedule the campaign
    Then the campaign status should be "Scheduled"

  Scenario: Set the activation period
    When I set the activation period to 2 weeks
    Then the activation period should be "2 weeks"

  # Expected to FAIL: the status stays "Draft" while a filter elsewhere says "Scheduled".
  # A pass means the subject was picked by matching text, not by meaning.
  @url:examples/campaign-app/index.html?decoy=1
  Scenario: Status assertion ignores a decoy
    Then the campaign status should be "Scheduled"
