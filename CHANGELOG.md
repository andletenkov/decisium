# Changelog

## [0.5.1](https://github.com/andletenkov/decisium/compare/v0.5.0...v0.5.1) (2026-11-12)


### Bug Fixes

* catch resolution regressions; record checks by structure, not text ([#95](https://github.com/andletenkov/decisium/issues/95)) ([9c60e99](https://github.com/andletenkov/decisium/commit/9c60e9990d49d7c3aac057349501827d08400da8))
* record only the answers a check's verdict read; one area distribution ([#96](https://github.com/andletenkov/decisium/issues/96)) ([219b2a4](https://github.com/andletenkov/decisium/commit/219b2a496c864c554158d0c888e1522446f45a2b))
* treat the cassette as a cache, never a judge ([#93](https://github.com/andletenkov/decisium/issues/93)) ([163b90e](https://github.com/andletenkov/decisium/commit/163b90eff5a8531d261206c48adfb705e50e76f2))

## [0.5.0](https://github.com/andletenkov/decisium/compare/v0.4.1...v0.5.0) (2026-11-10)


### Features

* decide assertions on explicit evidence and uncertainty ([#81](https://github.com/andletenkov/decisium/issues/81)) ([#86](https://github.com/andletenkov/decisium/issues/86)) ([9bbbe52](https://github.com/andletenkov/decisium/commit/9bbbe524a899a0f1b8a5826361562b887033cea7))
* decision provider interface with TypeSafe and OpenRouter ([#84](https://github.com/andletenkov/decisium/issues/84)) ([bb7fd5e](https://github.com/andletenkov/decisium/commit/bb7fd5eb8976f8b9db151be44a13fbae7f77d410))


### Bug Fixes

* absence check no longer passes when Jev sees the text shown ([#80](https://github.com/andletenkov/decisium/issues/80)) ([4af2226](https://github.com/andletenkov/decisium/commit/4af2226ec341341302782e3e92678209e6e5d37c))

## [0.4.1](https://github.com/andletenkov/decisium/compare/v0.4.0...v0.4.1) (2026-11-10)


### Bug Fixes

* a control and the text it only wraps are one answer, not a split ([#75](https://github.com/andletenkov/decisium/issues/75)) ([546928f](https://github.com/andletenkov/decisium/commit/546928f9e3d944e35c5ae56a01a3f1a16fd00226))
* replay pre-0.4.0 cassettes whose near holds a date or time ([#78](https://github.com/andletenkov/decisium/issues/78)) ([928502c](https://github.com/andletenkov/decisium/commit/928502c8d4017796ef19da9bae7188c0bf601ae2))


### Performance Improvements

* fewer browser round trips on replay; run the replay bench in CI ([#76](https://github.com/andletenkov/decisium/issues/76)) ([a918fa5](https://github.com/andletenkov/decisium/commit/a918fa5a071e5f679bc58cb4c220eb4c72e9fe42))

## [0.4.0](https://github.com/andletenkov/decisium/compare/v0.3.1...v0.4.0) (2026-11-09)


### Features

* anchor look-alike targets on the Step's quoted values ([#72](https://github.com/andletenkov/decisium/issues/72)) ([333fbe2](https://github.com/andletenkov/decisium/commit/333fbe26c7a838cebe28c97d6028b9e20efa46d8))


### Bug Fixes

* mask run-dependent values in the text that tells look-alikes apart ([#70](https://github.com/andletenkov/decisium/issues/70)) ([4ccc96d](https://github.com/andletenkov/decisium/commit/4ccc96d52fa54e0bc6ee53d72021da0258aef78d))

## [0.3.1](https://github.com/andletenkov/decisium/compare/v0.3.0...v0.3.1) (2026-11-09)


### Bug Fixes

* replay needs only the target a Turn acts on, not its unchosen candidates ([#67](https://github.com/andletenkov/decisium/issues/67)) ([6648935](https://github.com/andletenkov/decisium/commit/66489353652c3272fb27177f9f12253c448466d0))

## [0.3.0](https://github.com/andletenkov/decisium/compare/v0.2.1...v0.3.0) (2026-11-09)


### Features

* validate Decisium tags in lint and before run ([#59](https://github.com/andletenkov/decisium/issues/59)) ([9e5daae](https://github.com/andletenkov/decisium/commit/9e5daae95de40ee363a51208f9908e4d8ac19dcd))


### Performance Improvements

* faster cassette replay waits and observations ([#60](https://github.com/andletenkov/decisium/issues/60)) ([885d7b4](https://github.com/andletenkov/decisium/commit/885d7b4b02ebf49cd16ba1633ca5c45e22c49f00))

## [0.2.1](https://github.com/andletenkov/decisium/compare/v0.2.0...v0.2.1) (2026-11-06)


### Bug Fixes

* install the tarball's own Chromium in the pack smoke test ([#48](https://github.com/andletenkov/decisium/issues/48)) ([b4cfd05](https://github.com/andletenkov/decisium/commit/b4cfd05719db25359ea985dbd09057642939f53f))

## [0.2.0](https://github.com/andletenkov/decisium/compare/v0.1.5...v0.2.0) (2026-11-06)


### Features

* add unique run IDs for test data ([#44](https://github.com/andletenkov/decisium/issues/44)) ([6dfb8f1](https://github.com/andletenkov/decisium/commit/6dfb8f1a6adc71f0519e17bbb324ee1105037d09))
* declarative state preconditions with [@save](https://github.com/save):storage ([#43](https://github.com/andletenkov/decisium/issues/43)) ([bcd56c7](https://github.com/andletenkov/decisium/commit/bcd56c77391c992369dafa1c55c4baba99c41347))
* pin ambiguous action targets for keyless replay ([#35](https://github.com/andletenkov/decisium/issues/35)) ([2a19eb1](https://github.com/andletenkov/decisium/commit/2a19eb1acf651813fd99afe2a2f62a8d7c2e8e80))
* publish decisium docker image ([#42](https://github.com/andletenkov/decisium/issues/42)) ([4e461ce](https://github.com/andletenkov/decisium/commit/4e461ce18976b74f6decd871ba9b089ca856e35a))
* read Step wording with Jev where the rules read nothing ([#34](https://github.com/andletenkov/decisium/issues/34)) ([65bdeb5](https://github.com/andletenkov/decisium/commit/65bdeb5117f1399eb5bb566e579a9b99f5a43157))


### Bug Fixes

* Jev vetoes an inexact text match the words around it negate ([#33](https://github.com/andletenkov/decisium/issues/33)) ([a614877](https://github.com/andletenkov/decisium/commit/a61487730f2c363f808ae880e55e40004636b174))
* no silent 0/0 scenario runs ([#8](https://github.com/andletenkov/decisium/issues/8)) ([#32](https://github.com/andletenkov/decisium/issues/32)) ([8f921d1](https://github.com/andletenkov/decisium/commit/8f921d1d1bee55193a600cefc7d4c47747753126))
* preserve cassette entries across model upgrades ([#36](https://github.com/andletenkov/decisium/issues/36)) ([33af058](https://github.com/andletenkov/decisium/commit/33af058bdffd642d922c9ad100c4d9877187fbe5))
* resolve extensionless TypeScript imports automatically ([#38](https://github.com/andletenkov/decisium/issues/38)) ([75102de](https://github.com/andletenkov/decisium/commit/75102decb7cf9830ccb910f39e6e7fcaf3dfa362))
* run idle callbacks by a deadline so settle never waits the cap ([#41](https://github.com/andletenkov/decisium/issues/41)) ([f892d47](https://github.com/andletenkov/decisium/commit/f892d47307a19fa938c53a5de0e9b08cb8430848))
* write cassette entries on single lines ([#37](https://github.com/andletenkov/decisium/issues/37)) ([e39a795](https://github.com/andletenkov/decisium/commit/e39a795d3e19ce2095dddc37cf0acc56ae0c2de7))
