# CLI and configuration

## Commands

| Command | Does |
|---|---|
| `decisium run <file.feature[:line]>...` | Runs features; `:line` runs one scenario. |
| `decisium step "<step>" --url <url>` | Runs one Step, no feature file. For trying a wording. |
| `decisium lint <file.feature>...` | No browser, no model: how each Step will be read, and wordings to avoid. |
| `decisium pin <file.feature:line> <n>` | Confirms candidate `n` of an `AMBIGUOUS` action. See [Pin](https://andletenkov.github.io/decisium/ci.html#pin-an-ambiguous-target). |
| `decisium install [--with-deps]` | Downloads Chromium (`--with-deps`: Linux system libraries too). |
| `decisium doctor [<file.feature>...]` | Checks Node, Chromium, the API key and the start URLs. |

Exit codes: `0` passed, `1` a scenario failed, `2` configuration or infrastructure error.

## run flags

| Flag | |
|---|---|
| `--url <url\|file>` | Start URL; overrides `@url:`. |
| `--record new\|none\|all` | `new` (default): replay, record what is missing. `none`: replay only (CI). `all`: re-record everything. |
| `--parallel <n\|auto>` | Run features in parallel workers. |
| `--headed` | Show the browser. |
| `--strict` | Fail checks that passed with low confidence. |
| `--judged` | Let Jev judge subjective checks. |
| `--format <name[:path]>` | Any cucumber formatter, e.g. `junit:junit.xml`. Repeatable. |
| `--import <file>` | Your step definitions or hooks. Repeatable. |
| `-p <profile>` | A cucumber profile. |
| `--no-agent-report` | Do not write `report.md`. |
| `-v`, `--debug` | Print every page snapshot and answer; show stack traces. |
| `--report-dir`, `--check-timeout`, `--action-timeout`, `--max-turns`, `--confidence-target`, `--confidence-answer` | The options below, one flag each. |

## Decision providers

TypeSafe remains the default: its SDK is bundled, `TYPESAFE_API_KEY` is unchanged, and the default model is
`jev-1.14.0`. To use OpenRouter's typed Decisions API:

```sh
npm install @openrouter/sdk
export DECISIUM_MODEL_PROVIDER=openrouter
export DECISIUM_MODEL='~typesafe/jev-latest'
export DECISIUM_MODEL_API_KEY=... # or put it in .env; never commit keys
npx decisium run test.feature
```

Credential precedence: `DECISIUM_MODEL_API_KEY` wins over the selected provider's native variable
(`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`). The other provider's key is never used, and providers never switch
automatically. Native variables let you retain both providers' credentials while switching `DECISIUM_MODEL_PROVIDER`.
An explicitly empty generic key fails authentication rather than falling back. Keys are **environment-only** (shell or
`.env`): no API-key CLI argument or `worldParameters.decisium` field. They are excluded from reports, logs, traces and cassettes.

The supported optional peer is **`@openrouter/sdk@1.5.75`** (also pinned in development). This alpha API can change;
install that version explicitly if npm offers a newer incompatible release. It is loaded only on a live OpenRouter
request. TypeSafe and replay-only runs do not import it. `--record none` needs neither SDK installation nor API keys
for replay; `--judged` explicitly requests live judgments. There is no cross-provider or chat-completion fallback.
`decisium doctor --provider openrouter` checks the selected provider.

Both adapters send the shared structured state object, with string/string-array values, and `choice`/`noul` questions.
They require full choice distributions and noul probabilities, rejecting missing, refused or malformed answers.
The shared candidate and UI budgets remain the conservative **Jev** limits (255 choices, 80,000 UI characters), not a
claim that all models have identical capabilities. Only Jev models are currently smoke-tested; other typed models
must support these two question kinds and complete probability distributions.

Each decision has a total `decisionTimeout` (default 10 seconds), including SDK loading. Cancellation aborts the
transport. Neither adapter retries automatically. Failures use sanitized codes: `authentication`, `rate_limit`,
`unsupported`, `transport`, `malformed_response`, `timeout`, `cancelled`, `configuration`, `request_too_large`.
SDK errors, request headers and credentials are not serialized. Step text still goes to the selected provider;
never put secrets in literal Step text.

New cassette entries and Step trace results include `decisions`: provider, requested model, returned `resolvedModel`
and upstream provider when available, plus token usage (`null` when unavailable; individual unavailable counts are also `null`; measured zero stays zero).
`resolvedModel` is the API's exact identifier: `jev-latest` is still an alias, **not a pinned version**. Legacy aggregate
Step token totals count only measured tokens; `usageUnavailable: true` marks incomplete accounting.
Older cassettes remain replayable unchanged. The legacy top-level `model` is the recording configuration, not proof
of every entry's origin; per-entry metadata preserves old and new providers when a recording is partially healed.
Legacy entries without metadata have unknown provenance. No cassette format bump or SDK object serialization is needed.

Verified against the official SDK's [Decisions API](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/docs/sdks/decisions/README.md)
and `1.5.75` generated `decisionsrequest`, `decisionsresponse` and error schemas. OpenRouter accepts string, object or
array state; this integration uses objects. Its SDK exposes camelCase usage; TypeSafe exposes snake_case usage.
Contract tests run both real SDK serializers over fake HTTP, including cancellation and error sanitization.

## Options

`decisium run` loads your `cucumber.{js,mjs,cjs,json,yaml}` like cucumber-js does. Decisium options go in
`worldParameters.decisium`:

```js
// cucumber.mjs
export default {
  worldParameters: {
    decisium: { url: "http://localhost:3000", reportDir: "e2e/runs", checkTimeout: 10000 },
  },
};
```

| Option | Default | When to change |
|---|---|---|
| `url` | | Start URL for every scenario. Overrides `@url:`, so one set of features runs against dev, staging and prod. |
| `record` | `"new"` | `"none"` in CI. |
| `provider` | `"typesafe"` | `"openrouter"` for OpenRouter. |
| `model` | `"jev-1.14.0"` / `"~typesafe/jev-latest"` | Provider-specific ID; no automatic translation. |
| `decisionTimeout` | `10000` | Total ms per live decision. |
| `reportDir` | `"runs"` | To match your CI artifact path. |
| `checkTimeout` | `5000` | Slow page: ms a check waits for the expected state. |
| `actionTimeout` | `5000` | Slow app: ms to wait for the page to settle after an action. |
| `maxTurns` | `8` | Long flows in one Step (1–20). Or split the Step. |
| `confidence.target` | `0.5` | How sure Jev must be of the element. Reword the Step first. |
| `confidence.answer` | `0.8` | How sure Jev must be of other answers. Below `0.6` warns. |
| `states` | `"**/*.state.feature"` | Where [state](https://andletenkov.github.io/decisium/advanced.html#states) files live. |

Also `headed`, `judged`, `strict`, `verbose`, `debug`, `agentReport`. Precedence: flag > environment variable > config
file > default.

## Environment variables

Every option has an environment variable, so a CI job or a shell can change it without touching files:

| Variable | Flag | Option | Notes |
|---|---|---|---|
| `DECISIUM_URL` | `--url` | `url` | Start URL; overrides `@url:`. |
| `DECISIUM_RECORD` | `--record` | `record` | `new`, `none` or `all`. |
| `DECISIUM_MODEL_PROVIDER` | `--provider` | `provider` | `typesafe` or `openrouter`. |
| `DECISIUM_MODEL_API_KEY` | — | — | Environment-only key for the selected provider; overrides its native key. |
| `TYPESAFE_API_KEY` | — | — | TypeSafe fallback when `DECISIUM_MODEL_API_KEY` is unset. |
| `OPENROUTER_API_KEY` | — | — | OpenRouter fallback when `DECISIUM_MODEL_API_KEY` is unset. |
| `DECISIUM_MODEL` | `--model` | `model` | Provider-specific model ID. |
| `DECISIUM_DECISION_TIMEOUT` | `--decision-timeout` | `decisionTimeout` | Positive whole ms. |
| `DECISIUM_REPORT_DIR` | `--report-dir` | `reportDir` | Where run folders go. |
| `DECISIUM_CHECK_TIMEOUT` | `--check-timeout` | `checkTimeout` | ms. |
| `DECISIUM_ACTION_TIMEOUT` | `--action-timeout` | `actionTimeout` | ms. |
| `DECISIUM_MAX_TURNS` | `--max-turns` | `maxTurns` | 1-20. |
| `DECISIUM_CONFIDENCE_TARGET` | `--confidence-target` | `confidence.target` | 0 to 1. |
| `DECISIUM_CONFIDENCE_ANSWER` | `--confidence-answer` | `confidence.answer` | 0 to 1. |
| `DECISIUM_STATES` | | `states` | Glob of state files. |
| `DECISIUM_HEADED` | `--headed` | `headed` | `1` or `0`. |
| `DECISIUM_JUDGED` | `--judged` | `judged` | `1` or `0`. |
| `DECISIUM_STRICT` | `--strict` | `strict` | `1` or `0`. |
| `DECISIUM_VERBOSE` | `-v` | `verbose` | `1` or `0`. |
| `DECISIUM_DEBUG` | `--debug` | `debug` | `1` or `0`. |
| `DECISIUM_NO_AGENT_REPORT` | `--no-agent-report` | `agentReport: false` | `1` skips `report.md`. |

Other variables:

| Variable | Does |
|---|---|
| `SLOWMO` | Milliseconds to pause per browser action, for demos. |
| Any name you write as `"$NAME"` in a Step | A [secret placeholder](https://andletenkov.github.io/decisium/steps.html): its value is typed but never sent to Jev or logged. |

`DECISIUM_RUN_ID`, `DECISIUM_RUN_DIR`, `DECISIUM_STEP` and `DECISIUM_NO_INTENT` are internal; do not set them.
