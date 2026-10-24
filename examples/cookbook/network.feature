@url:examples/cookbook/index.html?network
Feature: Client steps, browser context tags and network replay (task 0048)
  Backs docs/cookbook.md. Run with --import examples/cookbook/network.steps.ts; the campaign manager must run on 5173
  to record (npm run example:server), not to replay.

  @viewport:390x844 @locale:de-DE
  Scenario: Context tags
    Then the Viewport should be "390x844"
    And the Locale should be "de-DE"

  Scenario: A client step mocks the API
    Given the campaigns API returns "Mocked Sale"
    When I click Load campaigns
    Then "Mocked Sale" should be shown
    And the status should be "Loaded 1 campaigns"

  @replay-network:**/api/campaigns
  Scenario: Backend calls replayed from the recording
    When I click Load campaigns
    Then "Autumn Sale" should be shown
