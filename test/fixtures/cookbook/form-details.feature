@url:test/fixtures/cookbook/form-details.html
Feature: Clear fields, native dates and on-leave validation (task 0046)
  Scenario: Clear a populated search field
    When I clear the Search field
    Then the search status should be "Search cleared"

  Scenario: Native date and time fields
    When I set the Start date to "2026-10-20"
    Then the Start date should be "2026-10-20"
    When I set the Start time to "14:30"
    Then the Start time should be "14:30"
    When I set the Appointment to "2026-10-20T14:30"
    Then the Appointment should be "2026-10-20T14:30"

  Scenario: Validate when leaving a field
    When I enter "invalid" in Email
    Then the email status should be "Invalid email"
