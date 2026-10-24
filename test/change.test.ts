import { test } from "node:test";
import assert from "node:assert/strict";
import { changes } from "../src/change.ts";
import { parseSnapshot, withPage } from "../src/observation.ts";

const table = (names: string[]) => parseSnapshot([
  "- table [ref=t1]:",
  "  - rowgroup [ref=g1]:",
  '    - row [ref=r0]:\n      - columnheader "Last Name" [ref=h1]',
  "  - rowgroup [ref=g2]:",
  ...names.map((n, i) => `    - row [ref=r${i + 1}]:\n      - cell "${n}" [ref=c${i + 1}]`),
].join("\n"));

test("changes: a sorted table reports its rows before and after", () => {
  assert.equal(changes(table(["Smith", "Bach", "Doe"]), table(["Bach", "Doe", "Smith"]), "h1"),
    "changed: rowgroup reordered: Smith, Bach, Doe -> Bach, Doe, Smith");
});

test("changes: rename, value and state changes, appeared and gone, nearest the acted-on element first", () => {
  const before = parseSnapshot(`- button "Add to cart" [ref=e1]\n- generic "Cart" [ref=e2]: 1\n- checkbox "News" [ref=e3]\n- paragraph [ref=e4]: Old\n- link "Help" [ref=e5]`);
  const after = parseSnapshot(`- button "Remove" [ref=f1]\n- generic "Cart" [ref=f2]: 2\n- checkbox "News" [checked] [ref=f3]\n- paragraph [ref=f5]: Saved\n- alert [ref=f6]: Added`);
  assert.equal(changes(before, after, "e1"),
    'changed: button "Add to cart" -> "Remove"; generic "Cart" value "1" -> "2"; checkbox "News" [unchecked] -> [checked]; paragraph value "Old" -> "Saved"; appeared: alert "Added"; gone: link "Help"');
});

test("changes: nothing changed says so", () => {
  const obs = () => parseSnapshot(`- button "Go" [ref=e1]`);
  assert.equal(changes(obs(), obs(), "e1"), "no visible change");
});

test("changes: a navigation comes first, and the summary is capped", () => {
  const page = (url: string, n: number) => withPage(parseSnapshot(Array.from({ length: n }, (_, i) => `- link "Entry number ${i}" [ref=e${i}]`).join("\n")), url, "T");
  const out = changes(page("https://x/a", 0), page("https://x/b", 30), "e0");
  assert.match(out, /^changed: url value "https:\/\/x\/a" -> "https:\/\/x\/b"; appeared: link "Entry number 0"/);
  assert.ok(out.length <= 320 && out.endsWith("; …"));
});

test("changes: secrets stay masked", () => {
  const before = parseSnapshot(`- textbox "Password" [ref=e1]`, new Set(["e1"]));
  const after = parseSnapshot(`- textbox "Password" [ref=e1]: hunter2`, new Set(["e1"]));
  const out = changes(before, after, "e1");
  assert.ok(!out.includes("hunter2") && out.includes("••••"), out);
});

test("changes: focus and cursor flips are not changes; a long text shows where it differs", () => {
  const long = "The Internet Fork me on GitHub Fork me on GitHub Data Tables";
  const before = parseSnapshot(`- button "Search" [ref=e1] [cursor=pointer]\n- paragraph [ref=e2]: ${long} 5 rows`);
  const after = parseSnapshot(`- button "Search" [active] [ref=e1]\n- paragraph [ref=e2]: ${long} 1 row`);
  assert.equal(changes(before, after, "e1"), 'changed: paragraph value "…ub Data Tables 5 rows" -> "…ub Data Tables 1 row"');
});

test("changes: a list item dragged to another list moved", () => {
  const board = (todo: string[], done: string[]) => parseSnapshot([
    `- list "To do" [ref=l1]:`, ...todo.map((t, i) => `  - listitem [ref=a${i}]: ${t}`),
    `- list "Done" [ref=l2]:`, ...done.map((t, i) => `  - listitem [ref=b${i}]: ${t}`)].join("\n"));
  assert.equal(changes(board(["Fix bug", "Write docs"], ["Ship release"]), board(["Write docs"], ["Ship release", "Fix bug"]), "a0"),
    'changed: listitem "Fix bug" moved from list "To do" to list "Done"');
});
