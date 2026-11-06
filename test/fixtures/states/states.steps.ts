// Client step definitions for states.feature: run with --import. Each logs what ran to $STATES_LOG.
import { Then, When } from "@cucumber/cucumber";
import { appendFileSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";

type W = { page: Page; context: BrowserContext };
const note = (what: string) => appendFileSync(process.env.STATES_LOG!, `${what}\n`);
const session = async (w: W) => ({
  user: await w.page.evaluate(() => localStorage.getItem("user")),
  cookie: (await w.context.cookies()).find((c) => c.name === "sid")?.value,
});

When("I log in", async function (this: W) {
  note("log in");
  await this.page.evaluate(() => localStorage.setItem("user", "admin"));
  await this.context.addCookies([{ name: "sid", value: "s3cret", url: this.page.url() }]);
});
When("I add an item", () => {
  note("add an item");
});
Then("I am logged in", async function (this: W) {
  note("check");
  const s = await session(this);
  if (s.user !== "admin" || s.cookie !== "s3cret") throw new Error("not logged in");
});
Then("the session is there", async function (this: W) {
  const s = await session(this);
  if (s.user !== "admin" || s.cookie !== "s3cret") throw new Error(`no session: ${JSON.stringify(s)}`);
});
