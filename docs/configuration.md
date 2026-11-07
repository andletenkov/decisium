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
| `url` | | Start URL for features without `@url:`. |
| `record` | `"new"` | `"none"` in CI. |
| `reportDir` | `"runs"` | To match your CI artifact path. |
| `checkTimeout` | `5000` | Slow page: ms a check waits for the expected state. |
| `actionTimeout` | `5000` | Slow app: ms to wait for the page to settle after an action. |
| `maxTurns` | `8` | Long flows in one Step (1–20). Or split the Step. |
| `confidence.target` | `0.5` | How sure Jev must be of the element. Reword the Step first. |
| `confidence.answer` | `0.8` | How sure Jev must be of other answers. Below `0.6` warns. |
| `states` | `"**/*.state.feature"` | Where [state](https://andletenkov.github.io/decisium/advanced.html#states) files live. |

Also `headed`, `judged`, `strict`, `verbose`, `debug`, `agentReport`. Every option has a flag (`--check-timeout`) and an
environment variable (`DECISIUM_CHECK_TIMEOUT`). Precedence: flag > environment > config file > default.
