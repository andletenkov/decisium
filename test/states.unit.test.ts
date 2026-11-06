import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFeature } from "../src/feature.ts";
import { forOrigin, SavedStorage } from "../src/saved.ts";
import { consumerChain, discoverStates, loadStates, nearMiss, parseStates, stateChain } from "../src/states.ts";

const SHOP = `@url:https://shop.example.com
Feature: Shop states

  @state-def:logged-in @save:storage
  Scenario: Logged in
    When I log in as "$USERNAME" with password "$PASSWORD"
    Then the header should show "Admin"

  @state-def:cart @state:logged-in
  Scenario: A cart
    When I add the "Backpack" to the cart
`;

const dir = () => mkdtempSync(join(tmpdir(), "decisium-states-"));
const states = (src = SHOP) => {
  const d = dir();
  writeFileSync(join(d, "shop.state.feature"), src);
  return loadStates([join(d, "shop.state.feature")]);
};

test("parseStates: names, url, dependency, @save:storage and Step lines", () => {
  const [login, cart] = parseStates(SHOP, "shop.state.feature");
  assert.deepEqual(
    { name: login.name, url: login.url, save: login.save, dep: login.dep, line: login.line },
    { name: "logged-in", url: "https://shop.example.com", save: true, dep: undefined, line: 5 },
  );
  assert.deepEqual(
    login.steps.map((s) => [s.kind, s.line]),
    [
      ["action", 6],
      ["assertion", 7],
    ],
  );
  assert.equal(cart.dep, "logged-in");
  assert.equal(cart.save, false);
});

test("parseStates rejects what would run differently than it reads", () => {
  const bad = (src: string, re: RegExp) => assert.throws(() => parseStates(src, "x.state.feature"), re);
  bad("@state-def:a\nFeature: f\n  Scenario: s\n    When I go\n", /on a Feature/);
  bad("Feature: f\n  Background:\n    When I go\n  @state-def:a\n  Scenario: s\n    When I go\n", /Background/);
  bad("Feature: f\n  Scenario: s\n    When I go\n", /no @state-def/);
  bad("Feature: f\n  @state-def:a @save:storage\n  Scenario: s\n    When I log in\n", /must end with a Then/);
  bad("Feature: f\n  @state-def:a @save:cookies\n  Scenario: s\n    Then I see it\n", /only @save:storage/);
  bad("Feature: f\n  @state-def:a @stat:b\n  Scenario: s\n    When I go\n", /did you mean @state:/);
});

test("loadStates: duplicates, unknown dependencies and cycles; stateChain orders dependencies first", () => {
  assert.deepEqual(
    stateChain(states(), "cart").map((d) => d.name),
    ["logged-in", "cart"],
  );
  assert.throws(() => stateChain(states(), "nope"), /unknown state "nope"/);
  assert.throws(() => states(SHOP + SHOP.split("\n").slice(2).join("\n")), /defined twice/);
  assert.throws(
    () => states("Feature: f\n  @state-def:a @state:zz\n  Scenario: s\n    When I go\n"),
    /unknown state "zz"/,
  );
  assert.throws(
    () =>
      states(
        "Feature: f\n  @state-def:a @state:b\n  Scenario: s\n    When I go\n  @state-def:b @state:a\n  Scenario: t\n    When I go\n",
      ),
    /state cycle: .*a -> b|state cycle: .*b -> a/,
  );
});

test("consumerChain checks the consumer's tags", () => {
  const all = states();
  const consumer = (src: string) => parseFeature(src, "c.feature")[0];
  const chain = consumerChain(all, consumer("Feature: f\n  @state:cart\n  Scenario: s\n    When I pay\n"), {});
  assert.deepEqual(
    chain.map((d) => d.name),
    ["logged-in", "cart"],
  );
  assert.deepEqual(consumerChain(all, consumer("Feature: f\n  Scenario: s\n    When I pay\n"), {}), []);
  const bad = (src: string, re: RegExp) => assert.throws(() => consumerChain(all, consumer(src), {}), re);
  bad("@state:cart\nFeature: f\n  Scenario: s\n    When I pay\n", /on a Feature is not supported/);
  bad("Feature: f\n  @state:cart @url:http://x\n  Scenario: s\n    When I pay\n", /@url: and @state: together/);
  bad("Feature: f\n  @state:cart @state:logged-in\n  Scenario: s\n    When I pay\n", /at most one/);
  bad("Feature: f\n  @state:nope\n  Scenario: s\n    When I pay\n", /unknown state "nope"/);
  bad("Feature: f\n  @stat:cart\n  Scenario: s\n    When I pay\n", /did you mean @state:/);
  bad("Feature: f\n  @state:cart @replay-network:**/api/**\n  Scenario: s\n    When I pay\n", /HAR/);
  // A feature-level @url: is fine: the state's url wins.
  assert.equal(
    consumerChain(all, consumer("@url:http://x\nFeature: f\n  @state:cart\n  Scenario: s\n    When I pay\n"), {})
      .length,
    2,
  );
});

test("nearMiss: typos of Decisium tags, not team tags", () => {
  assert.match(nearMiss("@viewprot:1x1")!, /@viewport:/);
  assert.match(nearMiss("@stat:x")!, /@state:/);
  assert.equal(nearMiss("@jira:ABC-1"), undefined);
  assert.equal(nearMiss("@owner:me"), undefined);
  assert.equal(nearMiss("@state:x"), undefined);
  assert.equal(nearMiss("@smoke"), undefined);
});

test("discoverStates finds *.state.feature, skipping node_modules", () => {
  const d = dir();
  mkdirSync(join(d, "features"));
  mkdirSync(join(d, "node_modules/x"), { recursive: true });
  writeFileSync(join(d, "features/a.state.feature"), "");
  writeFileSync(join(d, "features/a.feature"), "");
  writeFileSync(join(d, "node_modules/x/b.state.feature"), "");
  assert.deepEqual(discoverStates(undefined, d), [`${d}/features/a.state.feature`]);
});

test("forOrigin keeps only the effective origin's cookies and localStorage", () => {
  const cookie = (domain: string) => ({
    name: "s",
    value: "v",
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: "Lax" as const,
  });
  const s = forOrigin(
    {
      cookies: [cookie(".example.com"), cookie("shop.example.com"), cookie("staging.example.com")],
      origins: [
        { origin: "https://shop.example.com", localStorage: [] },
        { origin: "https://evil.com", localStorage: [] },
      ],
    },
    "https://shop.example.com/login",
  );
  assert.deepEqual(
    s.cookies.map((c) => c.domain),
    [".example.com", "shop.example.com"],
  );
  assert.deepEqual(
    s.origins.map((o) => o.origin),
    ["https://shop.example.com"],
  );
});

test("SavedStorage: 0600 files in a 0700 gitignored dir; one producer per state, others wait for it", async () => {
  const [login, cart] = [...states().values()];
  const a = new SavedStorage("runs/x", dir());
  const b = new SavedStorage("runs/x", a.dir.replace(/\/[^/]+$/, ""));
  assert.equal(a.dir, b.dir);
  assert.deepEqual(await a.plan([login, cart]), { load: undefined, mine: ["logged-in"] });
  assert.equal(statSync(a.dir).mode & 0o777, 0o700);
  const waiting = b.plan([login, cart], 5000, 10);
  let done = false;
  waiting.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, false); // a holds the lock
  a.write("logged-in", { cookies: [], origins: [] });
  assert.deepEqual(await waiting, { load: 0, mine: [] });
  assert.equal(statSync(join(a.dir, ".gitignore")).isFile(), true);
  assert.deepEqual(b.read("logged-in"), { cookies: [], origins: [] });
  b.forget("logged-in");
  assert.equal(b.has("logged-in"), false);
  assert.deepEqual(await b.plan([login]), { load: undefined, mine: ["logged-in"] });
  b.release();
  assert.equal(b.locked("logged-in"), false);
  await assert.rejects(
    a.plan([login, cart], 0, 1).then(() => b.plan([login], 0, 1)),
    /timed out/,
  );
  a.remove();
});
