# Installation

Needs Node 22.18+ (or 23.6+).

```sh
npm install --save-dev decisium
npx playwright install chromium
```

Live runs call Jev, TypeSafe's decision model, through the TypeSafe API: you need a TypeSafe API key. Decisium's code is
MIT; Jev is TypeSafe's hosted service under its own terms. Set the key in the environment or in a `.env` file in the
directory you run from:

```sh
echo 'TYPESAFE_API_KEY=...' >> .env
```

A replay (`--record none`) makes no model calls and does not need the key.

## Check the setup

```sh
npx decisium doctor features/checkout.feature
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
