# Frozen cassettes from v0.5.0

The cookbook features and the cassettes recorded with Decisium v0.5.0, copied once and never re-recorded.
`outcomes.json` is what v0.5.0 reported for each Step when it replayed them.

Every later version must replay them with no Jev call and report the same outcomes
(test/compat.test.ts). A change here is a breaking change for users' cassettes: do not
re-record or edit these files to make a test pass.
