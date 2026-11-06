import assert from "node:assert/strict";
import { test } from "node:test";
import { siteHref, slugify } from "../scripts/site.ts";

test("site: source links map to site pages, example sources on GitHub, or are dropped", () => {
  assert.equal(
    siteHref("../test/fixtures/cookbook/lab.feature#L6"),
    "https://github.com/andletenkov/decisium/blob/main/test/fixtures/cookbook/lab.feature#L6",
  );
  assert.equal(
    siteHref("test/fixtures/campaign-app.feature"),
    "https://github.com/andletenkov/decisium/blob/main/test/fixtures/campaign-app.feature",
  );
  assert.equal(siteHref("steps.md#secrets"), "steps.html#secrets");
  assert.equal(siteHref("docs/configuration.md"), "configuration.html");
  assert.equal(siteHref("https://x.dev/a.md"), "https://x.dev/a.md");
  assert.equal(siteHref("adr/0004-cucumber-native-configuration.md"), undefined);
  assert.equal(slugify("Scroll inside lists and panels, and up"), "scroll-inside-lists-and-panels-and-up");
  assert.equal(slugify("Memory (a check that refers back)"), "memory-a-check-that-refers-back");
});

test("site: search entries split a page at its h2/h3 headings, as plain text", async () => {
  const { searchEntries } = await import("../scripts/site.ts");
  const html = `<h1 id="t">T</h1><p>Intro &amp; more</p><h2 id="keys">Keys</h2><p>Press <code>Escape</code></p><h3 id="a-b">A &lt;b&gt;</h3><p>x</p>`;
  assert.deepEqual(searchEntries("steps", "Writing Steps", html), [
    { url: "steps.html", page: "Writing Steps", section: "", text: "T Intro & more" },
    { url: "steps.html#keys", page: "Writing Steps", section: "Keys", text: "Press Escape" },
    { url: "steps.html#a-b", page: "Writing Steps", section: "A <b>", text: "x" },
  ]);
});
