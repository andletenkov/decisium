import assert from "node:assert/strict";
import { test } from "node:test";
import { siteHref, slugify } from "../scripts/site.ts";

test("site: source links map to site pages, example lines, or are dropped", () => {
  assert.equal(siteHref("../examples/cookbook/lab.feature#L6"), "examples.html#lab-L6");
  assert.equal(siteHref("examples/campaign-app.feature"), "examples.html#campaign-app");
  assert.equal(siteHref("cookbook.md#flaky-steps"), "cookbook.html#flaky-steps");
  assert.equal(siteHref("docs/configuration.md"), "configuration.html");
  assert.equal(siteHref("https://x.dev/a.md"), "https://x.dev/a.md");
  assert.equal(siteHref("adr/0004-cucumber-native-configuration.md"), undefined);
  assert.equal(slugify("Scroll inside lists and panels, and up"), "scroll-inside-lists-and-panels-and-up");
  assert.equal(slugify("Memory (a check that refers back)"), "memory-a-check-that-refers-back");
});
