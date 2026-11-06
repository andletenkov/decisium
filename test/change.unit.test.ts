import { test } from "node:test";
import assert from "node:assert/strict";
import { changes } from "../src/change.ts";
import { parseSnapshot, withPage } from "../src/observation.ts";

const table = (names: string[]) =>
  parseSnapshot(
    [
      "- table [ref=t1]:",
      "  - rowgroup [ref=g1]:",
      '    - row [ref=r0]:\n      - columnheader "Last Name" [ref=h1]',
      "  - rowgroup [ref=g2]:",
      ...names.map((n, i) => `    - row [ref=r${i + 1}]:\n      - cell "${n}" [ref=c${i + 1}]`),
    ].join("\n"),
  );

test("changes: a sorted table reports its rows before and after", () => {
  assert.equal(
    changes(table(["Smith", "Bach", "Doe"]), table(["Bach", "Doe", "Smith"]), "h1"),
    "changed: rowgroup reordered: Smith, Bach, Doe -> Bach, Doe, Smith",
  );
});

test("changes: rename, value and state changes, appeared and gone, nearest the acted-on element first", () => {
  const before = parseSnapshot(
    `- button "Add to cart" [ref=e1]\n- generic "Cart" [ref=e2]: 1\n- checkbox "News" [ref=e3]\n- paragraph [ref=e4]: Old\n- link "Help" [ref=e5]`,
  );
  const after = parseSnapshot(
    `- button "Remove" [ref=f1]\n- generic "Cart" [ref=f2]: 2\n- checkbox "News" [checked] [ref=f3]\n- paragraph [ref=f5]: Saved\n- alert [ref=f6]: Added`,
  );
  assert.equal(
    changes(before, after, "e1"),
    'changed: button "Add to cart" -> "Remove"; generic "Cart" value "1" -> "2"; checkbox "News" [unchecked] -> [checked]; paragraph value "Old" -> "Saved"; appeared: alert "Added"; gone: link "Help"',
  );
});

test("changes: nothing changed says so", () => {
  const obs = () => parseSnapshot(`- button "Go" [ref=e1]`);
  assert.equal(changes(obs(), obs(), "e1"), "no visible change");
});

test("changes: a navigation comes first, and the summary is capped", () => {
  const page = (url: string, n: number) =>
    withPage(
      parseSnapshot(Array.from({ length: n }, (_, i) => `- link "Entry number ${i}" [ref=e${i}]`).join("\n")),
      url,
      "T",
    );
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
  assert.equal(
    changes(before, after, "e1"),
    'changed: paragraph value "…ub Data Tables 5 rows" -> "…ub Data Tables 1 row"',
  );
});

test("changes: a list item dragged to another list moved", () => {
  const board = (todo: string[], done: string[]) =>
    parseSnapshot(
      [
        `- list "To do" [ref=l1]:`,
        ...todo.map((t, i) => `  - listitem [ref=a${i}]: ${t}`),
        `- list "Done" [ref=l2]:`,
        ...done.map((t, i) => `  - listitem [ref=b${i}]: ${t}`),
      ].join("\n"),
    );
  assert.equal(
    changes(
      board(["Fix bug", "Write docs"], ["Ship release"]),
      board(["Write docs"], ["Ship release", "Fix bug"]),
      "a0",
    ),
    'changed: listitem "Fix bug" moved from list "To do" to list "Done"',
  );
});

test("changes: a container's text is left out when a change inside it says more; kept when nothing inside changed", () => {
  const page = (user: string, msg: string) =>
    parseSnapshot(`- main [ref=m1]:\n  - text: Login page ${msg}\n  - textbox "Username" [ref=u1]: ${user}`);
  assert.equal(changes(page("", "Hello"), page("tom", "Hello"), "u1"), 'changed: textbox "Username" value "" -> "tom"');
  const card = (n: string) => parseSnapshot(`- generic [ref=g1]:\n  - strong [ref=s1]: ${n}\n  - text: items left`);
  assert.equal(changes(card("2"), card("1")), 'changed: strong value "2" -> "1"');
  const files = (shown: boolean) =>
    parseSnapshot(
      `- main [ref=m1]:\n  - text: Files\n${shown ? '  - list "Files" [ref=l1]:\n    - listitem [ref=i1]: report.pdf\n' : ""}  - status [ref=s1]: ${shown ? "" : "Delete report.pdf"}`,
    );
  assert.equal(
    changes(files(true), files(false)),
    'changed: appeared: status "Delete report.pdf"; gone: listitem "report.pdf"',
  );
});

test("changes: what an action removed is listed where it was; the closing menu of the clicked item goes last", () => {
  const before = parseSnapshot(
    `- list "Files" [ref=l1]:\n  - listitem [ref=i1]: report.pdf\n  - listitem [ref=i2]: notes.txt\n- menu [ref=m1]:\n  - menuitem "Rename" [ref=r1]\n  - menuitem "Delete" [ref=d1]\n- status [ref=s1]: Ready`,
  );
  const after = parseSnapshot(
    `- list "Files" [ref=l1]:\n  - listitem [ref=i2]: notes.txt\n- status [ref=s1]: Deleted report.pdf`,
  );
  assert.equal(
    changes(before, after, "d1"),
    'changed: gone: listitem "report.pdf"; status value "Ready" -> "Deleted report.pdf"; gone: menuitem "Rename"; gone: menuitem "Delete"',
  );
});

test("changes: label, state, rename, churn, reorder, distance and diff details", async () => {
  const { withDialog } = await import("../src/observation.ts");
  const p = (s: string) => parseSnapshot(s);
  const cases: [string, string, string, string?][] = [
    [
      `- button "\ue001 ${"A".repeat(45)}" [ref=e1]: x`,
      `- button "\ue001 ${"A".repeat(45)}" [ref=e1]: y`,
      `changed: button "${"A".repeat(40)}…" value "x" -> "y"`,
    ],
    [
      `- list "L" [ref=l]:\n  - listitem "Item" [ref=i]`,
      `- listitem "Item" [ref=i]`,
      `changed: listitem "Item" moved from list "L" to the page; gone: list "L"`,
    ],
    [`- button "B" [pressed] [ref=e1]`, `- button "B" [ref=e1]`, `changed: button "B" [pressed] -> [no state]`],
    [`- button "B" [ref=e1]`, `- button "B" [expanded] [ref=e1]`, `changed: button "B" [no state] -> [expanded]`],
    [
      `- list "L" [ref=l]:\n  - listitem [ref=i]: Apple`,
      `- list "L" [ref=l]:\n  - listitem [ref=i]: Apricot`,
      `changed: listitem value "Apple" -> "Apricot"`,
    ],
    [`- generic [ref=g]:\n  - button "X" [ref=b]`, `- button "X" [ref=b]`, "no visible change"],
    [
      `- list "L" [ref=l]:\n  - listitem "b" [ref=1]\n  - listitem "a" [ref=2]`,
      `- list "L" [ref=l]:\n  - listitem "a" [ref=2]\n  - listitem "b" [ref=1]`,
      `changed: list "L" reordered: b, a -> a, b`,
    ],
    [
      `- list "L" [ref=l]:\n  - listitem [ref=1]: ${"x".repeat(25)}\n  - listitem [ref=2]: a`,
      `- list "L" [ref=l]:\n  - listitem [ref=2]: a\n  - listitem [ref=1]: ${"x".repeat(25)}`,
      `changed: list "L" reordered: ${"x".repeat(20)}…, a -> a, ${"x".repeat(20)}…`,
    ],
    [
      `- paragraph [ref=1]: a\n- paragraph [ref=2]: b\n- paragraph [ref=3]: c\n- button "Go" [ref=4]\n- paragraph [ref=5]: d`,
      `- paragraph [ref=1]: A\n- paragraph [ref=2]: B\n- paragraph [ref=3]: c\n- button "Go" [ref=4]\n- paragraph [ref=5]: D`,
      `changed: paragraph value "d" -> "D"; paragraph value "b" -> "B"; paragraph value "a" -> "A"`,
      "4",
    ],
    [
      `- paragraph [ref=1]: a\n- paragraph [ref=5]: d`,
      `- paragraph [ref=1]: A\n- paragraph [ref=5]: D`,
      `changed: paragraph value "a" -> "A"; paragraph value "d" -> "D"`,
      "zz",
    ],
    [
      `- paragraph [ref=1]: abcdefghijklmnopq1`,
      `- paragraph [ref=1]: abcdefghijklmnopq2`,
      `changed: paragraph value "…cdefghijklmnopq1" -> "…cdefghijklmnopq2"`,
    ],
    [
      `- paragraph [ref=1]: abcdefghijklmn1`,
      `- paragraph [ref=1]: abcdefghijklmn2`,
      `changed: paragraph value "abcdefghijklmn1" -> "abcdefghijklmn2"`,
    ],
  ];
  for (const [a, b, want, acted] of cases) assert.equal(changes(p(a), p(b), acted), want, want);
  const items = (o: string[]) => p(`- list "L" [ref=l]:\n${o.map((x) => `  - listitem "${x}" [ref=${x}]`).join("\n")}`);
  assert.equal(
    changes(items(["a", "b", "c", "d", "e", "f"]), items(["f", "e", "d", "c", "b", "a"])),
    `changed: list "L" reordered: a, b, c, d, e -> f, e, d, c, b`,
  );
  const dialog = withDialog(p(`- paragraph [ref=1]: b`), { type: "alert", message: "Hi", state: "open" });
  assert.equal(
    changes(p(`- paragraph [ref=1]: a`), dialog, "1"),
    `changed: appeared: alert "browser dialog"; paragraph value "a" -> "b"`,
  );
});

test("changes: the cap keeps whole entries up to 300 characters", () => {
  const p = (v: string) =>
    parseSnapshot(Array.from({ length: 12 }, (_, i) => `- paragraph [ref=e${i}]: ${v}${i}`).join("\n"));
  const out = changes(p("old"), p("new"));
  const entry = (i: number) => `paragraph value "old${i}" -> "new${i}"`;
  // each entry is 33-34 characters with its separator: 8 fit, the 9th would pass 300
  assert.equal(out, `changed: ${[0, 1, 2, 3, 4, 5, 6, 7].map(entry).join("; ")}; …`);
  const exact = parseSnapshot(`- paragraph [ref=e]: ${"a".repeat(0)}x`);
  assert.equal(changes(exact, parseSnapshot(`- paragraph [ref=e]: y`)), `changed: paragraph value "x" -> "y"`);
});
