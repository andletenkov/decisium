// Raw `npx cucumber-js <file.feature>` runs Decisium too; `decisium run` loads this file as well (see `decisium` usage).
// Options: worldParameters.decisium, overridden by DECISIUM_* env. A reporter is one more format entry, e.g.
// "cucumberjs-qase-reporter:/dev/null"; only one formatter may write to stdout (an entry without a path).
export default {
  import: ["src/steps.ts"],
  format: ["./src/formatter.ts"],
};
