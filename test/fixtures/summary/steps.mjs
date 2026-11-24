import { Given } from "@cucumber/cucumber";
Given("a step that passes", () => {});
Given("a step that fails", () => {
  throw new Error("boom");
});
Given("a step that skips", () => "skipped");
