# Configuration and reporters

`decisium run` loads configuration exactly like cucumber-js ([ADR 0004](adr/0004-cucumber-native-configuration.md)):
your `cucumber.{js,mjs,cjs,json,yaml}`, `-p <profile>`, and cucumber's `--format name[:path]` and `--import <file>`
flags, added to the file's values. Decisium adds its own step definitions to `import`.

## Decisium options

In `worldParameters.decisium`, so raw `npx cucumber-js` reads them too. Flags (`--url`, `--record`, `--strict`, ...)
and `DECISIUM_*` env (`DECISIUM_URL`, `DECISIUM_RECORD`, `DECISIUM_STRICT=1`, ...) override them.

```js
// cucumber.mjs
export default {
  worldParameters: { decisium: { record: "none", strict: true } },
  // url, record, headed, judged, strict, verbose, debug, agentReport
};
```

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
  // Raw cucumber-js only: Decisium's src/steps.ts and src/formatter.ts (decisium run adds both itself).
  import: ["path/to/decisium/src/steps.ts"],
  format: ["path/to/decisium/src/formatter.ts", "cucumberjs-qase-reporter:/dev/null"],
};
```

Tag scenarios `@QaseID=<id>`. A failing Step's message starts with its outcome; app failures (`ASSERTION_FAILED`,
`JUDGED_FAILED`, `BLOCKED`, `ACTION_FAILED`) report as `failed`, every other outcome as `invalid`. A marginal pass
reaches every reporter as a `text/plain` attachment `marginal-pass.txt` on its Step (Qase stores it as `file.txt`).
