// Raw `npx cucumber-js <file.feature>` runs Descisium too; options come from DESCISIUM_* env (see `descisium` usage).
import { devNull } from "node:os";
import { qaseOn } from "./src/qase.ts";

export default {
  import: ["src/steps.ts"],
  // Only one formatter may write to stdout; the Qase reporter writes nothing there itself.
  format: ["./src/formatter.ts", ...(qaseOn() ? [["cucumberjs-qase-reporter", devNull]] : [])],
};
