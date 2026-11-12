# Releasing

[release-please](https://github.com/googleapis/release-please-action) keeps a `chore(main): release x.y.z` PR open
from conventional commits (version bump, `CHANGELOG.md`, regenerated `site/`). Merge it after its
`docs: regenerate site for release` commit lands (when the site changed); merging it tags `vX.Y.Z`, creates the
GitHub release and runs `release.yml`, which tests, stages the npm publish and pushes the image. Then approve the staged
publish with 2FA: `npm stage list decisium`, `npm stage approve <id>`.

After the release, freeze its fixture cassettes (issue #91): copy `test/fixtures/cookbook` and
`test/fixtures/realistic` to `test/fixtures/compat/vX.Y.Z/`, write its `outcomes.json` from a `--record none` replay
(see `test/compat.test.ts`), and open a PR. Every later PR replays them in CI with no Jev call. A change that alters a
recorded resolution on purpose re-records the live fixture cassettes (label `re-record-approved`); the cassette diff
shows the change, and the release notes mention it.
