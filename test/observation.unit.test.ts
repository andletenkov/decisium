import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AriaNode,
  assertableText,
  type Element,
  MASK,
  type Observation,
  parseSnapshot,
  renderSnapshot,
  withClipboard,
  withDialog,
  withDownload,
  withPage,
} from "../src/observation.ts";

test("renderSnapshot: names escaped, states, ref and cursor, /url and text children, one-line text, nothing for false/undefined", () => {
  const nodes: AriaNode[] = [
    { role: "heading", name: 'Releases: "x"\\y', level: 1, ref: "e1" },
    { role: "link", name: "Docs", ref: "e2", cursor: "pointer", url: "/docs" },
    {
      role: "list",
      ref: "e3",
      children: [
        "  first   item ",
        {
          role: "listitem",
          name: "two",
          text: "  more\ntext ",
          children: [{ role: "checkbox", name: "Done", checked: true, disabled: false, ref: "e4" }],
        },
      ],
    },
    { role: "paragraph", text: " plain\n text " },
    { role: "button", name: "", expanded: undefined, ref: "e5" },
    { role: "group", children: [] },
  ];
  assert.equal(
    renderSnapshot(nodes),
    [
      `- heading "Releases: \\"x\\"\\\\y" [level=1] [ref=e1]`,
      `- link "Docs" [ref=e2] [cursor=pointer]:`,
      `  - /url: /docs`,
      `- list [ref=e3]:`,
      `  - text: first item`,
      `  - listitem "two":`,
      `    - text: more text`,
      `    - checkbox "Done" [checked] [ref=e4]`,
      `- paragraph: plain text`,
      `- button [ref=e5]`,
      `- group`,
    ].join("\n"),
  );
  assert.equal(renderSnapshot([{ role: "listitem", text: "only", children: [] }]), "- listitem: only");
});

const snap = [
  `- navigation "Main" [ref=e1]:`,
  `  - link "Home" [ref=e2]:`,
  `    - /url: "/home"`,
  `  - checkbox "Remember" [ref=e3]`,
  `  - checkbox "Agree" [checked] [ref=e4]`,
  `- combobox "Country" [ref=e5]:`,
  `  - option "France"`,
  `  - option "Spain" [selected]`,
  `- textbox "Password" [ref=e6]: hunter2`,
  `- combobox "Search" [ref=e7]`,
  `- generic:`,
  `- generic [ref=e8]:`,
  `  - text: Total 5`,
  `- generic [ref=e9]:`,
  `  - text: Email`,
  `  - textbox "Email" [ref=e10]`,
  `- generic [ref=e11]:`,
  `  - button "Go" [disabled] [ref=e12]`,
  `- table [ref=e13]:`,
  `  - row [ref=e14]:`,
  `    - columnheader "Name" [ref=e15]`,
  `    - cell [ref=e16]`,
  `- region [scrollable] [ref=e17]`,
  `- img "Logo" [draggable] [ref=e18]`,
  `- generic "Card" [ref=e19]`,
  `- button "Info" [description="More details"] [ref=e20]`,
  `- paragraph [ref=e21]: ${"x".repeat(70)}`,
  `garbage line ${"y".repeat(210)}`,
  `- link "Out" [ref=e22]:`,
  `  - /url: /out`,
].join("\n");

const view = (e: Element) => ({
  line: e.line,
  verb: e.verb,
  value: e.value,
  text: e.text,
  parent: e.parent?.ref,
  url: e.url,
  options: e.options,
  secret: e.secret,
  description: e.description,
  state: e.state,
});
const byRef = (obs: Observation, ref: string) => {
  const el = [...obs.readable, ...obs.areas].find((e) => e.ref === ref);
  assert.ok(el, ref);
  return el;
};
const el = (line: string, more: Partial<ReturnType<typeof view>> = {}) => ({
  line,
  verb: "CLICK",
  value: "",
  text: "",
  parent: undefined,
  url: undefined,
  options: [],
  secret: false,
  description: undefined,
  state: "",
  ...more,
});

test("parseSnapshot: the text Jev reads, which elements act, read and hold, and each element's fields", () => {
  const obs = parseSnapshot(snap, new Set(["e6"]), new Set(["e7"]), new Set(["e19"]));
  assert.equal(
    obs.text,
    [
      `- navigation "Main" [ref=e1]:`,
      `  - link "Home" [ref=e2]:`,
      `  - checkbox "Remember" [unchecked] [ref=e3]`,
      `  - checkbox "Agree" [checked] [ref=e4]`,
      `- combobox "Country" [ref=e5]:`,
      `  - option "France"`,
      `  - option "Spain" [selected]`,
      `- textbox "Password" [ref=e6]: ${MASK}`,
      `- combobox "Search" [ref=e7]`,
      `- generic [ref=e8]:`,
      `  - text: Total 5`,
      `- text: Email`,
      `- textbox "Email" [ref=e10]`,
      `- button "Go" [disabled] [ref=e12]`,
      `- table [ref=e13]:`,
      `  - row [ref=e14]:`,
      `    - columnheader "Name" [ref=e15]`,
      `    - cell [ref=e16]`,
      `- region [scrollable] [ref=e17]`,
      `- img "Logo" [draggable] [ref=e18]`,
      `- generic "Card" [ref=e19]`,
      `- button "Info" [description="More details"] [ref=e20]`,
      `- paragraph [ref=e21]: ${"x".repeat(70)}`,
      `garbage line ${"y".repeat(187)}…`,
      `- link "Out" [ref=e22]:`,
    ].join("\n"),
  );
  const refs = (els: Element[]) => els.map((e) => e.ref).join();
  assert.equal(refs(obs.elements), "e2,e3,e4,e5,e6,e7,e10,e15,e17,e18,e19,e20,e22");
  assert.equal(refs(obs.readable), "e1,e2,e3,e4,e5,e6,e7,e10,e12,e15,e17,e18,e19,e20,e21,e22,e8");
  assert.equal(refs(obs.areas), "e1,e8,e9,e11,e13,e14");
  assert.equal(
    obs.pageText,
    `Main\nHome\nRemember\nAgree\nCountry\nPassword ${MASK}\nSearch\n\nTotal 5\n\nEmail\nEmail\n\nGo\n\n\nName\n\n\nLogo\nCard\nInfo\n${"x".repeat(70)}\nOut\n`,
  );
  assert.deepEqual(
    byRef(obs, "e14").cells?.map((c) => c.ref),
    ["e15", "e16"],
  );
  assert.equal(byRef(obs, "e13").cells, undefined);
  const expected: Record<string, ReturnType<typeof el>> = {
    e1: el(`navigation "Main"`, { text: "Main Home Remember Agree" }),
    e2: el(`link "Home"`, { text: "Home", parent: "e1", url: "/home" }),
    e3: el(`checkbox "Remember" [unchecked]`, { text: "Remember", parent: "e1", state: "[unchecked]" }),
    e4: el(`checkbox "Agree" [checked]`, { text: "Agree", parent: "e1", state: "[checked]" }),
    e5: el(`combobox "Country" value="Spain"`, {
      verb: "SELECT",
      value: "Spain",
      text: "Country",
      options: ["France", "Spain"],
    }),
    e6: el(`textbox "Password" value="${MASK}"`, { verb: "TYPE", value: MASK, text: `Password ${MASK}`, secret: true }),
    e7: el(`combobox "Search"`, { verb: "TYPE", text: "Search" }),
    e8: el(`generic value="Total 5"`, { value: "Total 5", text: " Total 5" }),
    e9: el("generic", { text: " Email Email" }),
    e10: el(`textbox "Email"`, { verb: "TYPE", text: "Email", parent: "e9" }),
    e12: el(`button "Go" [disabled]`, { text: "Go", parent: "e11", state: "[disabled]" }),
    e15: el(`columnheader "Name"`, { text: "Name", parent: "e14" }),
    e17: el("region [scrollable]", { state: "[scrollable]" }),
    e18: el(`img "Logo" [draggable]`, { text: "Logo", state: "[draggable]" }),
    e19: el(`generic "Card"`, { text: "Card" }),
    e20: el(`button "Info" description="More details"`, { text: "Info", description: "More details" }),
    e21: el(`paragraph value="${"x".repeat(60)}…"`, { value: "x".repeat(70), text: "x".repeat(70) }),
    e22: el(`link "Out"`, { text: "Out", url: "/out" }),
  };
  for (const [ref, want] of Object.entries(expected)) assert.deepEqual(view(byRef(obs, ref)), want, ref);
});

test("parseSnapshot: defaults treat nothing as secret, editable or a target; an empty value is not masked", () => {
  const obs = parseSnapshot(
    [`- textbox "Password" [ref=e1]`, `- combobox "Search" [ref=e2]`, `- generic "Card" [ref=e3]`].join("\n"),
    new Set(["e1"]),
  );
  assert.equal(obs.elements.map((e) => e.ref).join(), "e1,e2");
  assert.equal(obs.elements[0].value, "");
  assert.equal(obs.elements[1].verb, "CLICK");
  assert.equal(parseSnapshot(`- textbox "Name" [ref=e1]: Ada`).elements[0].value, "Ada");
});

test("parseSnapshot: radio, switch and menu checkboxes get [unchecked]; a /url outside a link is dropped; options need a combobox above", () => {
  const obs = parseSnapshot(
    [
      `- radio "A" [ref=e1]`,
      `- switch "B" [ref=e2]`,
      `- menuitemcheckbox "C" [ref=e3]`,
      `- menuitemradio "D" [ref=e4]`,
      `- radio "E" [checked=mixed] [ref=e5]`,
      `- button "F" [ref=e6]:`,
      `  - /url: /f`,
      `- option "Loose"`,
      `- combobox "G" [ref=e7]`,
      `- option "Sibling"`,
      `- button "Next" [ref=e8]`,
      `- slider "Volume" [ref=e9]`,
      `- spinbutton "Qty" [ref=e10]`,
      `- searchbox "Find" [ref=e11]`,
      `- tab "T" [ref=e12]`,
      ``,
      `   `,
    ].join("\n"),
  );
  assert.deepEqual(
    obs.elements.map((e) => [e.ref, e.state, e.verb]),
    [
      ["e1", "[unchecked]", "CLICK"],
      ["e2", "[unchecked]", "CLICK"],
      ["e3", "[unchecked]", "CLICK"],
      ["e4", "[unchecked]", "CLICK"],
      ["e5", "[checked=mixed]", "CLICK"],
      ["e6", "", "CLICK"],
      ["e7", "", "CLICK"],
      ["e8", "", "CLICK"],
      ["e9", "", "TYPE"],
      ["e10", "", "TYPE"],
      ["e11", "", "TYPE"],
      ["e12", "", "CLICK"],
    ],
  );
  assert.equal(obs.elements[5].url, undefined);
  assert.deepEqual(obs.elements[6].options, []);
  assert.ok(!obs.text.includes("/url"));
  assert.ok(obs.text.includes(`- option "Loose"`));
  assert.ok(!obs.text.includes("\n\n"));
});

test("parseSnapshot: a combobox's options stop at the next element, so a later option is not its own", () => {
  const obs = parseSnapshot(
    [`- combobox "A" [ref=e1]:`, `  - option "One"`, `- button "B" [ref=e2]:`, `  - option "Two"`].join("\n"),
  );
  assert.deepEqual(obs.elements[0].options, ["One"]);
  assert.equal(obs.elements[0].value, "");
});

test("parseSnapshot: text only labelling a control keeps a wrapper hidden; a scrollable or named wrapper is kept", () => {
  const obs = parseSnapshot(
    [
      `- generic [ref=e1]:`,
      `  - textbox "Name" [ref=e2]`,
      `- generic [scrollable] [ref=e3]:`,
      `  - text: Name2`,
      `  - textbox "Name2" [ref=e4]`,
      `- generic [ref=e5]:`,
      `  - text: Label`,
      `  - text: Extra`,
      `  - textbox "Label" [ref=e6]`,
    ].join("\n"),
  );
  assert.ok(!obs.text.includes("[ref=e1]"));
  assert.ok(obs.text.includes("[ref=e3]"));
  assert.ok(obs.text.includes("[ref=e5]"));
  assert.equal(obs.readable.find((e) => e.ref === "e5")?.value, "Label Extra Label");
  assert.equal(obs.readable.find((e) => e.ref === "e3")?.value, "");
});

test("assertableText: typed controls compare their value, other controls their value or description, content its name", () => {
  const e = (role: string, more: Partial<Element> = {}) => ({ role, name: "N", value: "", ...more }) as Element;
  assert.equal(assertableText(e("textbox")), "");
  assert.equal(assertableText(e("combobox", { value: "V" })), "V");
  assert.equal(assertableText(e("button")), undefined);
  assert.equal(assertableText(e("button", { value: "V" })), "V");
  assert.equal(assertableText(e("button", { description: "D" })), "D");
  assert.equal(assertableText(e("link")), "N");
  assert.equal(assertableText(e("heading")), "N");
  assert.equal(assertableText(e("heading", { value: "V" })), "V");
});

const base = (): Observation => ({ text: "- body", elements: [], readable: [], areas: [], pageText: "" });
const empty = (): Observation => ({ text: "", elements: [], readable: [], areas: [], pageText: "" });
const pseudo = (ref: string, role: string, name: string, value: string, state: string, line: string): Element => ({
  ref,
  role,
  name,
  value,
  state,
  secret: false,
  verb: "CLICK",
  options: [],
  text: value,
  line,
});

test("withPage: url, title and tabs (only when given) read on top, a page target line, not in pageText", () => {
  const long = `https://x.test/${"a".repeat(70)}`;
  const obs = withPage(base(), long, "Home");
  assert.equal(obs.text, `- page "Home" [ref=page]\n- url: ${long}\n- title: Home\n- body`);
  assert.deepEqual(obs.readable, [
    pseudo("url", "url", "", long, "", `url value="${long.slice(0, 60)}…"`),
    pseudo("title", "title", "", "Home", "", `title value="Home"`),
  ]);
  assert.equal(obs.pageText, "");
  const tabs = withPage(empty(), "u", "t", "2 open, this is tab 2");
  assert.equal(tabs.text, `- page "t" [ref=page]\n- url: u\n- title: t\n- tabs: 2 open, this is tab 2`);
  assert.deepEqual(
    tabs.readable.map((e) => e.ref),
    ["url", "title", "tabs"],
  );
});

test("withDialog, withDownload, withClipboard: nothing to add returns the same observation", () => {
  const obs = base();
  assert.equal(withDialog(obs), obs);
  assert.equal(withDownload(obs), obs);
  assert.equal(withClipboard(obs), obs);
  assert.equal(withClipboard(obs, ""), obs);
});

test("withDialog: a readable 'browser dialog' with its state, on top", () => {
  const dialog = { type: "confirm", message: "Sure?", state: "dismissed" } as const;
  const obs = withDialog(base(), dialog);
  assert.equal(obs.text, `- confirm "browser dialog" [dismissed]: Sure?\n- body`);
  assert.equal(obs.dialog, dialog);
  assert.deepEqual(obs.readable, [
    pseudo(
      "dialog",
      "confirm",
      "browser dialog",
      "Sure?",
      "[dismissed]",
      `confirm "browser dialog" value="Sure?" [dismissed]`,
    ),
  ]);
  assert.equal(withDialog(empty(), dialog).text, `- confirm "browser dialog" [dismissed]: Sure?`);
});

test("withDownload: name plus text contents, size or [empty], whitespace folded in the lines", () => {
  const obs = withDownload(base(), { name: "a.csv", size: 12, text: "x,y\n1,2" });
  assert.equal(obs.text, `- download "downloaded file" [12 bytes]: a.csv x,y 1,2\n- body`);
  assert.deepEqual(obs.readable, [
    pseudo(
      "download",
      "download",
      "downloaded file",
      "a.csv\nx,y\n1,2",
      "[12 bytes]",
      `download "downloaded file" value="a.csv x,y 1,2" [12 bytes]`,
    ),
  ]);
  const bin = withDownload(empty(), { name: "e.bin", size: 0 });
  assert.equal(bin.text, `- download "downloaded file" [empty]: e.bin`);
  assert.equal(bin.readable[0].value, "e.bin");
  assert.equal(bin.readable[0].state, "[empty]");
});

test("withClipboard: copied text readable, whitespace folded in the lines", () => {
  const obs = withClipboard(base(), "a\n  b");
  assert.equal(obs.text, `- clipboard "copied text": a b\n- body`);
  assert.deepEqual(obs.readable, [
    pseudo("clipboard", "clipboard", "copied text", "a\n  b", "", `clipboard "copied text" value="a b"`),
  ]);
  assert.equal(withClipboard(empty(), "c").text, `- clipboard "copied text": c`);
});

test("pseudo-element top lines are capped at 200 characters", () => {
  const long = "z".repeat(300);
  assert.equal(withClipboard(empty(), long).text, `- clipboard "copied text": ${long}`.slice(0, 200) + "…");
  assert.equal(withPage(empty(), "u", long).text.split("\n")[0], `- page "${long}`.slice(0, 200) + "…");
});

test("parseSnapshot: dropped wrappers leave no gaps, so a line never looks nested in a list it is not in", () => {
  // GitHub file view: "Raw" sits next to the "File view" list, not in it. With the wrappers' indentation kept, it lined
  // up with the list's buttons and Jev scoped `"Raw" should appear` to the list (AMBIGUOUS).
  const obs = parseSnapshot(
    [
      `- list "File view" [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - button "Code" [ref=e3]`,
      `- generic:`,
      `  - generic:`,
      `    - link "Raw" [ref=e4]`,
    ].join("\n"),
  );
  assert.equal(
    obs.text,
    [
      `- list "File view" [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - button "Code" [ref=e3]`,
      `- link "Raw" [ref=e4]`,
    ].join("\n"),
  );
});
