// Experiment: can a failing Step tell an app error from a page that just lacks its control, on real sites?
// Cases: "api-down" (only the site's data API answers 500), "normal" (a Step the page cannot do), "user-error"
// (the app rejects the user's input) and "toast" (a success message on screen). Expected: api-down -> APP_ERROR,
// every other case -> no classification (the Step's own outcome stands).
// With --save, each page's snapshot and failed requests become labelled cases for scripts/bench-failure.ts
// (scripts/failure-cases.json): on an api-down page, its data request is what the data Step needs, and none of the
// failures is what the "normal" Step (one the page never offers) needs; on every other page, none is.
// Usage: node --env-file=.env scripts/error-sites.ts [filter] [--repeat 3] [--save]   (JSON lines on stdout)
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

const filter = process.argv[2]?.startsWith("--") ? "" : (process.argv[2] ?? "");
const r = process.argv.indexOf("--repeat");
const REPEAT = r > 0 ? Number(process.argv[r + 1]) : 3;

const SAVE = process.argv.includes("--save");
const saved: {
  site: string;
  kind: string;
  step: string;
  url: string;
  snapshot: string;
  failed: string[];
  needed: string[];
}[] = [];

for (const c of CASES.filter((x) => `${x.site} ${x.kind}`.includes(filter))) {
  for (let run = 1; run <= REPEAT; run++) {
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
      await page.waitForTimeout(c.setup ? 8000 : 4000);
      const failed = b.failedRequests();
      const lines = [...new Set(failed.filter(failureOutcome).map(describeFailure))];
      const expected = c.kind === "api-down" ? "APP_ERROR" : "none";
      const got =
        failed.map(failureOutcome).find((o) => o === "APP_ERROR") ?? failed.map(failureOutcome).find(Boolean) ?? "none";
      if (SAVE && run === 1 && lines.length) {
        const obs = await b.observe();
        const page = { site: c.site, url: c.url, snapshot: obs.text, failed: lines };
        const needed = c.api ? lines.filter((l) => c.api!.test(l)) : [];
        saved.push({ ...page, kind: c.kind, step: c.step, needed });
        const other = CASES.find((x) => x.site === c.site && x.kind === "normal");
        if (c.api && other) saved.push({ ...page, kind: "api-down-unrelated", step: other.step, needed: [] });
      }
      console.log(
        JSON.stringify({
          site: c.site,
          kind: c.kind,
          run,
          expected,
          got,
          right: got === expected,
          failed: failed.map(describeFailure),
        }),
      );
    } catch (err) {
      console.log(JSON.stringify({ site: c.site, kind: c.kind, run, error: String(err).split("\n")[0].slice(0, 160) }));
    } finally {
      await b.close();
    }
  }
}
if (SAVE) writeFileSync("scripts/failure-cases.json", `${JSON.stringify(saved, null, 1)}\n`);
