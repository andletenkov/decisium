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
| `TYPESAFE_API_KEY` | Jev API key for live runs. Read from the environment or from `.env`; replays need none. |
| `SLOWMO` | Milliseconds to pause per browser action, for demos. |
| Any name you write as `"$NAME"` in a Step | A [secret placeholder](https://andletenkov.github.io/decisium/steps.html): its value is typed but never sent to Jev or logged. |

`DECISIUM_RUN_ID`, `DECISIUM_RUN_DIR`, `DECISIUM_STEP` and `DECISIUM_NO_INTENT` are internal; do not set them.
