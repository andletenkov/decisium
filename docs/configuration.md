# Configuration and reporters

`decisium run` loads configuration exactly like cucumber-js:
your `cucumber.{js,mjs,cjs,json,yaml}`, `-p <profile>`, and cucumber's `--format name[:path]` and `--import <file>`
flags, added to the file's values. Decisium adds its own step definitions to `import`.

## Decisium options

In `worldParameters.decisium`, so raw `npx cucumber-js` reads them too. Flags (`--url`, `--record`, `--strict`, ...)
and `DECISIUM_*` env (`DECISIUM_URL`, `DECISIUM_RECORD`, `DECISIUM_STRICT=1`, ...) override them.

```js
// cucumber.mjs
export default {
  worldParameters: { decisium: { record: "none", strict: true } },
  // url, record, headed, judged, strict, verbose, debug, agentReport,
  // reportDir, confidence: { target, answer }, checkTimeout, actionTimeout, maxTurns
};
```

Precedence: flag > `DECISIUM_*` env > `worldParameters.decisium` > default. A value of the wrong type or out of range
fails at startup (exit 2). `--parallel` workers read the same values.

### Tuning

```js
// cucumber.mjs
export default {
  worldParameters: {
    decisium: {
      url: "http://localhost:3000",
      reportDir: "e2e/runs",
      confidence: { target: 0.6, answer: 0.85 },
      checkTimeout: 10000,
      actionTimeout: 10000,
      maxTurns: 12,
    },
  },
};
```

| Option | Default | Flag | Env | Affects |
|---|---|---|---|---|
| `reportDir` | `"runs"` | `--report-dir` | `DECISIUM_REPORT_DIR` | Where `<reportDir>/<timestamp>/` (log, trace, screenshots, `report.md`) is written. |
| `confidence.target` | `0.5` | `--confidence-target` | `DECISIUM_CONFIDENCE_TARGET` | How sure Jev must be of the element an action acts on (and a drag's drop target). In (0, 1]. |
| `confidence.answer` | `0.8` | `--confidence-answer` | `DECISIUM_CONFIDENCE_ANSWER` | Every other answer: a check's required state, the value to type or select, which earlier value a check refers to, a dialog answer. A pass under `answer` + 0.1 is marginal. In (0, 1]. |
| `checkTimeout` | `5000` | `--check-timeout` | `DECISIUM_CHECK_TIMEOUT` | Ms a check waits for the page to reach the expected state. |
| `actionTimeout` | `5000` | `--action-timeout` | `DECISIUM_ACTION_TIMEOUT` | Ms after an action to wait for requests and DOM changes to settle. |
| `maxTurns` | `8` | `--max-turns` | `DECISIUM_MAX_TURNS` | Turns an action Step may take before `STEP_TIMEOUT`, 1-20. |

Only the top probability is configurable; the lead over the runner-up stays fixed (0.1 target, 0.3 answer): it is
what catches "two controls look the same". Confidence affects live answers only (a replay reuses recorded
resolutions); timeouts and `maxTurns` apply to replays too. The effective values go into the run event in
`trace.jsonl`, and `report.md` says when confidence was not the default.

When to change them:

- Slow app: raise `checkTimeout` and `actionTimeout`.
- Long flow in one Step (a wizard): raise `maxTurns`, or split the Step.
- `AMBIGUOUS` on a clear page: reword the Step first, then raise or lower `confidence.target`.
- Marginal passes: reword. Lowering `confidence.answer` below 0.8 prints a warning: a wrong reading can then pass.

## Reporters

Any cucumber formatter: cucumber's own `junit`, `json`, `html`, `message`, or a package such as the official Qase
reporter. Only one formatter may write to stdout: one configured without a path takes it; otherwise Decisium's console
output does.

```sh
decisium run features/login.feature --format junit:reports/junit.xml
```

### Qase

Decisium ships nothing Qase-specific; wire the official reporter as in any cucumber project.

```sh
npm install --save-dev cucumberjs-qase-reporter
echo '{"mode":"report"}' > qase.config.json   # or mode "testops" with QASE_TESTOPS_API_TOKEN, QASE_TESTOPS_PROJECT
decisium run features/login.feature --format cucumberjs-qase-reporter:/dev/null
```

Or in your configuration, which raw `npx cucumber-js` uses too:

```js
// cucumber.mjs
export default {
  // Raw cucumber-js only: Decisium's steps and formatter (decisium run adds both itself).
  import: ["node_modules/decisium/dist/steps.js"],
  format: ["decisium/formatter", "cucumberjs-qase-reporter:/dev/null"],
};
```

Tag scenarios `@QaseID=<id>`. A failing Step's message starts with its outcome; app failures (`ASSERTION_FAILED`,
`JUDGED_FAILED`, `BLOCKED`, `ACTION_FAILED`) report as `failed`, every other outcome as `invalid`. A marginal pass
reaches every reporter as a `text/plain` attachment `marginal-pass.txt` on its Step (Qase stores it as `file.txt`).
