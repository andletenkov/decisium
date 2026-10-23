@url:examples/cookbook/index.html?contacts
Feature: Data tables and doc strings (task 0038)
  Backs docs/cookbook.md. Scenarios marked "Should FAIL" show a wording the cookbook warns against.

  Scenario: Fill a form from a table and check the table on the page
    When I fill in the new contact:
      | First name | Ada      |
      | Last name  | Lovelace |
    And I check these roles:
      | Mathematician |
    And I write the notes:
      """
      Wrote the first program.
      Born in London.
      """
    Then the notes should say:
      """
      Wrote the first program.
      Born in London.
      """
    When I add the contact
    Then the contacts table should list:
      | First name | Roles         |
      | Ada        | Mathematician |
      | Charles    | Inventor      |
    And the contacts table should show:
      | Lovelace |
      | Babbage  |

  Scenario: Add contacts from a table with a header row
    When I add these contacts:
      | First name | Last name | Roles    |
      | Grace      | Hopper    | Inventor |
      | Alan       | Turing    | Mathematician |
    Then the contacts table should list exactly:
      | First name | Last name | Roles         |
      | Charles    | Babbage   | Inventor      |
      | Grace      | Hopper    | Inventor      |
      | Alan       | Turing    | Mathematician |

  # Should FAIL: a check's first table row is its header, so one row compares nothing.
  Scenario: A check table with only one row
    When I fill in the new contact:
      | First name | Ada |
    Then the new contact should show:
      | First name | Ada |
