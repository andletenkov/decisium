// Labelled real-site cases for scripts/bench-failure.ts: does a failed request explain why a Step is blocked?
// Cases: "api-down" (only the site's data API answers 500), "normal" (a Step the page cannot do), "user-error"
// (the app rejects the user's input) and "toast" (a success message on screen). Each page with failed requests Jev
// would be asked about becomes a labelled case for scripts/bench-failure.ts (scripts/failure-cases.json): on an
// api-down page its data request is what the data Step needs, and none is what the "normal" Step (one the page never
// offers) needs; on every other page, none is.
// Usage: node scripts/error-sites.ts   (live sites, no model key needed)
import type { Page } from "playwright";
import { Browser } from "../src/browser.ts";
import { writeFileSync } from "node:fs";
import { describeFailure, failureOutcome } from "../src/runner.ts";

type Kind = "api-down" | "normal" | "user-error" | "toast";
interface Case {
  site: string;
  kind: Kind;
  url: string;
  step: string;
  api?: RegExp; // api-down: the requests that fail
  setup?: (p: Page) => Promise<void>;
}

const orangeLogin = (user: string, pass: string) => async (p: Page) => {
  await p.getByPlaceholder("Username").fill(user);
  await p.getByPlaceholder("Password").fill(pass);
  await p.getByRole("button", { name: "Login" }).click();
};
const sauceLogin = (pass: string) => async (p: Page) => {
  await p.locator("#user-name").fill("standard_user");
  await p.locator("#password").fill(pass);
  await p.locator("#login-button").click();
};

const CASES: Case[] = [
  // api-down: the page's own data request fails
  {
    site: "hn-algolia",
    kind: "api-down",
    url: "https://hn.algolia.com/?q=playwright",
    step: "I open the first story",
    api: /\/1\/indexes\//,
  },
  {
    site: "demoqa-books",
    kind: "api-down",
    url: "https://demoqa.com/books",
    step: 'I open the book "Git Pocket Guide"',
    api: /\/BookStore\/v1\//,
  },
  {
    site: "swagger",
    kind: "api-down",
    url: "https://petstore.swagger.io/",
    step: "I expand the GET /pet/{petId} operation",
    api: /swagger\.json/,
  },
  {
    site: "realworld",
    kind: "api-down",
    url: "https://demo.realworld.show/",
    step: "I open the first article",
    api: /api\.realworld\.show\/api\/articles/,
  },
  {
    site: "conduit",
    kind: "api-down",
    url: "https://conduit.bondaracademy.com/",
    step: "I open the first article",
    api: /conduit-api\.bondaracademy\.com\/api\/articles/,
  },
  {
    site: "github-issues",
    kind: "api-down",
    url: "https://github.com/microsoft/playwright/issues",
    step: "I open the first issue",
    api: /\/issues\/(views\.json|viewer)/,
  },
  {
    site: "demoblaze",
    kind: "api-down",
    url: "https://www.demoblaze.com/",
    step: 'I open the product "Samsung galaxy s6"',
    api: /api\.demoblaze\.com\/entries/,
  },
  {
    site: "toolshop",
    kind: "api-down",
    url: "https://practicesoftwaretesting.com/",
    step: 'I open the product "Combination Pliers"',
    api: /api\.practicesoftwaretesting\.com\/products/,
  },
  {
    site: "bstackdemo",
    kind: "api-down",
    url: "https://bstackdemo.com/",
    step: 'I add the "iPhone 12" to the cart',
    api: /\/api\/products/,
  },
  {
    site: "orangehrm",
    kind: "api-down",
    url: "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login",
    step: "I open the time at work widget details",
    api: /\/api\/v2\/dashboard\//,
    setup: orangeLogin("Admin", "admin123"),
  },
  // normal: the page loaded fine, the Step asks for something it does not offer
  {
    site: "hn-algolia",
    kind: "normal",
    url: "https://hn.algolia.com/?q=playwright",
    step: "I open the admin settings",
  },
  { site: "demoqa-books", kind: "normal", url: "https://demoqa.com/books", step: "I switch the site to dark mode" },
  { site: "realworld", kind: "normal", url: "https://demo.realworld.show/", step: "I open the billing page" },
  {
    site: "github-issues",
    kind: "normal",
    url: "https://github.com/microsoft/playwright/issues",
    step: "I delete the repository",
  },
  {
    site: "demoblaze",
    kind: "normal",
    url: "https://www.demoblaze.com/",
    step: "I change the site language to German",
  },
  { site: "toolshop", kind: "normal", url: "https://practicesoftwaretesting.com/", step: "I open my order history" },
  { site: "bstackdemo", kind: "normal", url: "https://bstackdemo.com/", step: "I switch the site to dark mode" },
  {
    site: "orangehrm",
    kind: "normal",
    url: "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login",
    step: "I export the payroll",
    setup: orangeLogin("Admin", "admin123"),
  },
  {
    site: "wikipedia",
    kind: "normal",
    url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
    step: "I edit the infobox birth date",
  },
  // user-error: the app rejects what the user entered (not an app failure)
  {
    site: "saucedemo",
    kind: "user-error",
    url: "https://www.saucedemo.com/",
    step: "I add the backpack to the cart",
    setup: sauceLogin("wrong"),
  },
  {
    site: "orangehrm",
    kind: "user-error",
    url: "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login",
    step: "I open the PIM module",
    setup: orangeLogin("Admin", "wrong"),
  },
  {
    site: "the-internet",
    kind: "user-error",
    url: "https://the-internet.herokuapp.com/login",
    step: "I open the secure area",
    setup: async (p) => {
      await p.locator("#username").fill("tomsmith");
      await p.locator("#password").fill("wrong");
      await p.locator("button[type=submit]").click();
    },
  },
  // toast: a success message is on screen, the Step asks for something the page does not offer
  {
    site: "the-internet",
    kind: "toast",
    url: "https://the-internet.herokuapp.com/notification_message_rendered",
    step: "I archive the message",
  },
  {
    site: "toolshop",
    kind: "toast",
    url: "https://practicesoftwaretesting.com/",
    step: "I apply the coupon code",
    setup: async (p) => {
      await p.locator("[data-test=product-name]").first().click();
      await p.locator("[data-test=add-to-cart]").click();
    },
  },
];

const saved: {
  site: string;
  kind: string;
  step: string;
  url: string;
  snapshot: string;
  failed: string[];
  needed: string[];
}[] = [];

for (const c of CASES) {
  const b = await Browser.open("about:blank");
  try {
    const page = b.context.pages()[0];
    if (c.api)
      await b.context.route(c.api, (route) =>
        route.fulfill({ status: 500, body: '{"error":"Internal Server Error"}', contentType: "application/json" }),
      );
    await b.execute({ verb: "GOTO", value: c.url });
    if (c.setup) {
      await page.waitForLoadState("domcontentloaded");
      await c.setup(page);
    }
    await page.waitForTimeout(c.setup ? 8000 : 4000); // a login redirect loads the dashboard late
    const lines = [...new Set(b.failedRequests().filter(failureOutcome).map(describeFailure))];
    console.log(`${c.kind} ${c.site}: ${lines.length} failed request(s) Jev would be asked about`);
    if (!lines.length) continue; // nothing to ask: the Step keeps its own outcome
    const shown = { site: c.site, url: c.url, snapshot: (await b.observe()).text, failed: lines };
    saved.push({ ...shown, kind: c.kind, step: c.step, needed: c.api ? lines.filter((l) => c.api!.test(l)) : [] });
    const other = CASES.find((x) => x.site === c.site && x.kind === "normal");
    if (c.api && other) saved.push({ ...shown, kind: "api-down-unrelated", step: other.step, needed: [] });
  } catch (err) {
    console.log(`${c.kind} ${c.site}: ${String(err).split("\n")[0].slice(0, 160)}`);
  } finally {
    await b.close();
  }
}
writeFileSync("scripts/failure-cases.json", `${JSON.stringify(saved, null, 1)}\n`);
