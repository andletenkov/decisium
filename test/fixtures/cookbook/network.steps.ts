// Client step definitions for network.feature (task 0048): run with --import. Every other line goes to Jev.
import { Given } from "@cucumber/cucumber";
import type { BrowserContext } from "playwright";

Given("the campaigns API returns {string}", async function (this: { context: BrowserContext }, name: string) {
  await this.context.route("**/api/campaigns", route =>
    route.fulfill({ json: [{ id: 1, name, status: "Draft" }], headers: { "access-control-allow-origin": "*" } }));
});
