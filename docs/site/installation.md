# Installation

Needs Node 22.18+ (or 23.6+).

```sh
npm install --save-dev decisium
npx playwright install chromium
```

Decisium calls Jev through the TypeSafe API. Set the key in the environment or in a `.env` file in the directory you
run from:

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
