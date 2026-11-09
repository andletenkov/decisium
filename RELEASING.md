# Releasing

[release-please](https://github.com/googleapis/release-please-action) keeps a `chore(main): release x.y.z` PR open
from conventional commits (version bump, `CHANGELOG.md`, regenerated `site/`). Merge it after its
`docs: regenerate site for release` commit lands (when the site changed); merging it tags `vX.Y.Z`, creates the
GitHub release and runs `release.yml`, which tests, stages the npm publish and pushes the image. Then approve the staged
publish with 2FA: `npm stage list decisium`, `npm stage approve <id>`.
