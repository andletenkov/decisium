// Load Decisium's runtime natively before tsx to keep Node's coverage source maps consistent.
import "./browser.ts";
import "./execute.ts";
import "./jev.ts";
import "./report.ts";
import { register as registerCjs } from "tsx/cjs/api";
import { register as registerEsm } from "tsx/esm/api";

registerCjs();
registerEsm();
