# Installation

Needs Node 22.18+ (or 23.6+). Install it one of two ways:

**Global**: one `decisium` command for every project on the machine.

```sh
npm install -g decisium
decisium install
```

**Per project**: the version is pinned in `package.json`, so teammates and CI replay cassettes with the version that
recorded them. Needed for [raw cucumber-js](cucumber-js.md). Run the commands through `npx`:

```sh
npm install --save-dev decisium
npx decisium install
```

These docs write `decisium …`; with a per-project install, type `npx decisium …`.

`decisium install` downloads the Chromium build Decisium's Playwright drives; on Linux, `decisium install --with-deps`
also installs the system libraries it needs.

Live runs call Jev, TypeSafe's decision model, through the TypeSafe API: you need a TypeSafe API key. Decisium's code is
MIT; Jev is TypeSafe's hosted service under its own terms. Set the key in the environment or in a `.env` file in the
directory you run from:

```sh
echo 'TYPESAFE_API_KEY=...' >> .env
```

A replay (`--record none`) makes no model calls and does not need the key.

## Check the setup

```sh
decisium doctor features/checkout.feature
```

`doctor` checks Node, Chromium and the key (one tiny Jev call). Given features, it also opens every start URL. Each
check prints `[OK]` or `[FAIL]`; the exit code is 2 when one fails.

## What is sent to Jev

On a live run, per Turn: the Step's text and a text snapshot of the page (Playwright's accessibility tree: roles,
names, visible text, link URLs), plus the message of an open browser dialog. No screenshots, no cookies, no network traffic.

- `"$NAME"` secrets are sent as the token only; the value never leaves your machine, and is masked back wherever the
  page shows it.
- A value written literally in a Step is sent to Jev, recorded in the cassette and written to `log.txt`.
- Replays (`--record none`) send nothing.
