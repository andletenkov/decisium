import assert from "node:assert/strict";
import { test } from "node:test";
import { siteHref, slugify } from "../scripts/site.ts";

test("site: source links map to site pages, example sources on GitHub, or are dropped", () => {
  assert.equal(siteHref("../test/fixtures/cookbook/lab.feature#L6"), "https://github.com/andletenkov/decisium/blob/main/test/fixtures/cookbook/lab.feature#L6");
  assert.equal(siteHref("test/fixtures/campaign-app.feature"), "https://github.com/andletenkov/decisium/blob/main/test/fixtures/campaign-app.feature");
  assert.equal(siteHref("steps.md#secrets"), "steps.html#secrets");
  assert.equal(siteHref("docs/configuration.md"), "configuration.html");
  assert.equal(siteHref("https://x.dev/a.md"), "https://x.dev/a.md");
  assert.equal(siteHref("adr/0004-cucumber-native-configuration.md"), undefined);
  assert.equal(slugify("Scroll inside lists and panels, and up"), "scroll-inside-lists-and-panels-and-up");
  assert.equal(slugify("Memory (a check that refers back)"), "memory-a-check-that-refers-back");
});
