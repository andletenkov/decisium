import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Cassette, describe, find, pin, RECORD_MODES, resolve, stepKey, UiChanged } from "../src/cassette.ts";
import { type Decider, fmt, gate, named, NotYet, type Pick } from "../src/decision.ts";
import { DEFAULTS } from "../src/options.ts";
import { parseSnapshot } from "../src/observation.ts";
import type { ParsedStep } from "../src/step.ts";

const tmp = () => `${mkdtempSync(`${tmpdir()}/cassette-unit-`)}/t.cassette.json`;
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const pick = (probabilities: Record<string, number>): Pick => ({
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0],
  probabilities,
});
const sure = (choice: string) => pick({ [choice]: 1 });
const action = (text: string, kind: ParsedStep["kind"] = "action"): ParsedStep => ({ text, kind });

test("RECORD_MODES, stepKey numbers repeated labels, UiChanged carries its reason", () => {
  assert.deepEqual(RECORD_MODES, ["none", "new", "all"]);
  const labels = ["a", "b", "a", "a"];
  assert.deepEqual(
    labels.map((_, i) => stepKey("S", labels, i)),
    ["S: a", "S: b", "S: a (#2)", "S: a (#3)"],
  );
  const e = new UiChanged("gone");
  assert.equal(e.message, "UI_CHANGED: gone");
  assert.equal(e.reason, "gone");
  assert.ok(e instanceof Error);
});

test("describe: strings as is, Resolutions with name, container, near and position", () => {
  assert.equal(describe("scroll"), "scroll");
  assert.equal(describe({ role: "button", name: "", container: "" }), "button");
  assert.equal(
    describe({ role: "button", name: "Add", container: `list "Items"`, near: "Pen", nth: 1, of: 3 }),
    `button "Add" in list "Items" near "Pen" (#2 of 3 identical)`,
  );
});

test("resolve and find: unique by role, name and container; peers told apart by text, else by position", () => {
  const obs = parseSnapshot(
    [
      `- list "Cart" [ref=e1]:`,
      `  - listitem [ref=e2]:`,
      `    - text: Pen`,
      `    - button "Add" [ref=e3]`,
      `  - listitem [ref=e4]:`,
      `    - text: Ink`,
      `    - button "Add" [ref=e5]`,
      `- button "Twin" [ref=e6]`,
      `- button "Twin" [ref=e7]`,
      `- button "Solo" [ref=e8]`,
    ].join("\n"),
  );
  const all = obs.elements;
  const by = (ref: string) => all.find((e) => e.ref === ref)!;
  assert.deepEqual(resolve(by("e8"), all), { role: "button", name: "Solo", container: "" });
  const pen = resolve(by("e3"), all);
  assert.deepEqual(pen, { role: "button", name: "Add", container: `list "Cart"`, near: "Pen Add" });
  assert.deepEqual(resolve(by("e5"), all).near, "Ink Add");
  assert.deepEqual(resolve(by("e7"), all), { role: "button", name: "Twin", container: "", nth: 1, of: 2 });
  assert.equal(find(pen, all), by("e3"));
  assert.equal(find(resolve(by("e7"), all), all), by("e7"));
  assert.equal(find(resolve(by("e8"), all), all), by("e8"));
  assert.equal(
    find({ role: "button", name: "Twin", container: "" }, all),
    `button "Twin" matches 2 elements now, needs exactly 1`,
  );
  assert.equal(
    find({ role: "button", name: "Twin", container: "", nth: 0, of: 3 }, all),
    `button "Twin" (#1 of 3 identical) matches 2 elements now, needs 3`,
  );
  assert.equal(
    find({ role: "link", name: "x", container: "" }, all),
    `link "x" matches 0 elements now, needs exactly 1`,
  );
});

test("resolve: a long distinguishing text is kept as its start and a hash", () => {
  const long = (w: string) => `${w} ${"x".repeat(250)}`;
  const obs = parseSnapshot(
    `- listitem [ref=e1]:\n  - button "Go" [ref=e2]\n- listitem [ref=e3]:\n  - button "Go" [ref=e4]`,
  );
  // Both buttons share their own text "Go": what tells them apart is their listitem's long text.
  const [a, b] = obs.elements;
  a.parent = { ...a.parent!, text: long("a") };
  b.parent = { ...b.parent!, text: long("b") };
  const r = resolve(a, [a, b]);
  assert.match(r.near!, /^a x{78}… \[[0-9a-f]{8}\]$/);
  assert.notEqual(resolve(b, [a, b]).near, r.near);
  assert.equal(find(r, [a, b]), a);
});

/** A scripted live Decider that counts calls; each question answers what it is given. */
function scripted(answers: Partial<Record<keyof Decider, unknown>>) {
  const calls: string[] = [];
  const d = {} as Record<string, unknown>;
  for (const [q, a] of Object.entries(answers))
    d[q] = async () => {
      calls.push(q);
      return a;
    };
  return { live: d as unknown as Decider, calls };
}

const page = parseSnapshot(
  [
    `- textbox "Name" [active] [ref=e1]`,
    `- button "Save" [ref=e2]`,
    `- list "Items" [ref=e3]:`,
    `  - listitem "One" [ref=e4]`,
  ].join("\n"),
);

test("cassette: generated values are recorded as templates and replayed with new values", async () => {
  const path = tmp();
  const before = parseSnapshot('- button "Open Agent abc123 and abc123" [ref=e1]');
  const after = parseSnapshot('- button "Open Agent xyz789 and xyz789" [ref=e2]');
  const { live, calls } = scripted({ turn: { done: 0, target: sure("e1"), action: sure("click") } });
  const rec = new Cassette(path, "m", "new");
  const writer = rec.step("step", live, undefined, { "{{decisium.runId}}": "abc123" });
  await writer.turn("open", before, []);
  assert.equal(writer.done(true), "recorded");
  rec.save();
  assert.match(readFileSync(path, "utf8"), /Open Agent \{\{decisium\.runId\}\} and \{\{decisium\.runId\}\}/);
  const replay = new Cassette(path, "m", "none").step("step", live, undefined, { "{{decisium.runId}}": "xyz789" });
  assert.equal((await replay.turn("open", after, [])).target.choice, "e2");
  assert.equal(replay.done(true), "replayed");
  assert.deepEqual(calls, ["turn"]);
});

test("cassette: a recorded Step stores every answer as Resolutions and replays them with no Jev call", async () => {
  const p = tmp();
  const turn = { done: 0.1, target: pick({ e1: 0.9, e2: 0.1 }), action: pick({ type: 0.7, click: 0.3 }) };
  const assessment = { kind: sure("value"), state: sure("disabled"), subject: sure("e4"), area: sure("e3") };
  const { live, calls } = scripted({
    turn,
    value: sure("Ada"),
    drop: sure("e4"),
    dialog: sure("accept"),
    assess: assessment,
    recall: sure("Ada"),
  });
  const rec = new Cassette(p, "m", "new");
  const d = rec.step("S: x", live);
  assert.equal(await d.turn("x", page, []), turn);
  assert.deepEqual(await d.value("x", page, page.elements[0], ["Ada"]), sure("Ada"));
  assert.deepEqual(await d.drop("x", page, page.elements[0]), sure("e4"));
  assert.deepEqual(await d.dialog("x", page, ["accept", "dismiss"]), sure("accept"));
  assert.deepEqual(await d.assess("x", page, false), assessment);
  assert.deepEqual(await d.recall("x", { Ada: "earlier" }), sure("Ada"));
  assert.equal(d.done(true), "recorded");
  assert.equal(rec.recorded, 1);
  rec.save();
  const file = read(p);
  assert.equal(file.model, "m");
  assert.deepEqual(file.entries["S: x"], {
    confidence: DEFAULTS.confidence,
    turns: [
      {
        done: 0.1,
        target: [[{ role: "textbox", name: "Name", container: "" }, 0.9]],
        action: [["type", 0.7]], // "click" dropped: a textbox cannot be clicked as an action
        value: [["Ada", 1]],
        drop: [[{ role: "listitem", name: "One", container: `list "Items"` }, 1]],
      },
      { dialog: [["accept", 1]] },
    ],
    check: {
      kind: sure("value"),
      state: sure("disabled"),
      subject: [[{ role: "listitem", name: "One", container: `list "Items"` }, 1]],
      area: [[{ role: "list", name: "Items", container: "" }, 1]],
    },
    recall: [["Ada", 1]],
  });
  assert.deepEqual(calls, ["turn", "value", "drop", "dialog", "assess", "recall"]);

  const play = new Cassette(p, "m", "none");
  const r = play.step("S: x", live);
  const t = await r.turn("x", page, []);
  assert.equal(t.done, 0.1);
  assert.deepEqual(t.target.probabilities, { e1: 0.9 });
  assert.equal(t.target.choice, "e1");
  assert.deepEqual(t.target.recordedConfidence, DEFAULTS.confidence);
  assert.equal(t.target.confirmed, undefined);
  assert.equal(t.action?.choice, "type");
  assert.equal((await r.value("x", page, page.elements[0], ["Ada"])).choice, "Ada");
  assert.equal((await r.drop("x", page, page.elements[0])).choice, "e4");
  assert.equal((await r.dialog("x", page, ["accept", "dismiss"])).choice, "accept");
  const a = await r.assess("x", page, false);
  assert.equal(a.subject.choice, "e4");
  assert.equal(a.area.choice, "e3");
  assert.equal(a.kind.choice, "value");
  assert.deepEqual(a.kind.recordedConfidence, DEFAULTS.confidence);
  assert.equal((await r.recall("x", { Ada: "earlier" })).choice, "Ada");
  assert.equal(r.done(true), "replayed");
  assert.equal(play.replayed, 1);
  assert.equal(calls.length, 6);
  const before = readFileSync(p, "utf8");
  play.save();
  assert.equal(readFileSync(p, "utf8"), before);
  assert.match(before, /^\{\n {2}"model": "m",\n {2}"entries": \{\n {4}"S: x": \{.*\}\n {2}\}\n\}\n$/s);
});

test("cassette: replay-only fails a new Step with UiChanged and never writes", async () => {
  const p = tmp();
  const { live, calls } = scripted({ turn: { done: 1, target: sure("e2") } });
  const c = new Cassette(p, "m", "none");
  const d = c.step("S: new", live);
  await assert.rejects(d.turn("x", page, []), (e: unknown) => {
    assert.ok(e instanceof UiChanged);
    assert.match(e.reason, /^this step has no recorded resolution: it is new or was reworded/);
    return true;
  });
  assert.deepEqual(await d.intent!("x", false), {});
  assert.equal(d.done(true), undefined);
  c.save();
  assert.equal(calls.length, 0);
  assert.throws(() => readFileSync(p));
});

const recorded = (entry: unknown) => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ model: "m", entries: { "S: x": entry } }));
  return p;
};
const saveTarget = { role: "button", name: "Save", container: "" };

test("cassette: replay-only waits (NotYet) for a recorded element not on the page yet; other misses fail at once", async () => {
  const p = recorded({ turns: [{ done: 0, target: [[{ role: "button", name: "Gone", container: "" }, 1]] }] });
  const d = new Cassette(p, "m", "none").step("S: x", scripted({}).live);
  await assert.rejects(d.turn("x", page, []), (e: unknown) => {
    assert.ok(e instanceof NotYet);
    assert.ok(e.final instanceof UiChanged);
    assert.equal(
      e.final.reason,
      `the recorded resolution no longer holds: button "Gone" matches 0 elements now, needs exactly 1`,
    );
    return true;
  });
  const misses: [unknown, (d: ReturnType<Cassette["step"]>) => Promise<unknown>, string][] = [
    [{ turns: [] }, (d) => d.turn("x", page, []), "recorded 0 turns, this is turn 1"],
    [{}, (d) => d.turn("x", page, []), "recorded 0 turns, this is turn 1"],
    [
      { turns: [{ dialog: [["accept", 1]] }] },
      (d) => d.turn("x", page, []),
      "turn 1 answered a browser dialog when recorded",
    ],
    [
      { turns: [{ done: 0, target: [["e9", 1]] }] },
      (d) => d.turn("x", page, []),
      `recorded answer "e9" is not offered now`,
    ],
    [
      { turns: [{ done: 0, target: [[saveTarget, 1]], action: [["type", 1]] }] },
      (d) => d.turn("x", page, []),
      `recorded action "type" is not offered now`,
    ],
    [{ turns: [] }, (d) => d.dialog("x", page, ["accept"]), "turn 1 did not answer a browser dialog when recorded"],
    [
      { turns: [{ dialog: [["dismiss", 1]] }] },
      (d) => d.dialog("x", page, ["accept"]),
      `recorded dialog answer "dismiss" is not offered now`,
    ],
    [{}, (d) => d.assess("x", page, false), "no recorded check"],
    [{}, (d) => d.recall("x", {}), "no recorded recall"],
    [
      { recall: [["Bob", 1]] },
      (d) => d.recall("x", { Ada: "s" }),
      `recorded earlier value "Bob" is not in this scenario now`,
    ],
  ];
  for (const [entry, ask, why] of misses) {
    const d = new Cassette(recorded(entry), "m", "none").step("S: x", scripted({}).live);
    await assert.rejects(ask(d), (e: unknown) => {
      assert.ok(e instanceof UiChanged, why);
      assert.equal(e.reason, `the recorded resolution no longer holds: ${why}`);
      return true;
    });
  }
});

test("cassette: value and drop misses are reported against the recorded turn", async () => {
  const turn0 = { done: 0, target: [[saveTarget, 1]] };
  for (const [entry, ask, why] of [
    [{ turns: [turn0] }, (d) => d.value("x", page, page.elements[0], ["Ada"]), "no recorded value"],
    [
      { turns: [{ ...turn0, value: [["Bob", 1]] }] },
      (d) => d.value("x", page, page.elements[0], ["Ada"]),
      `recorded value "Bob" is not offered now`,
    ],
    [{ turns: [turn0] }, (d) => d.drop("x", page, page.elements[0]), "no recorded drop target"],
  ] as [unknown, (d: ReturnType<Cassette["step"]>) => Promise<unknown>, string][]) {
    const d = new Cassette(recorded(entry), "m", "none").step("S: x", scripted({}).live);
    await d.turn("x", page, []);
    await assert.rejects(ask(d), (e: unknown) => e instanceof UiChanged && e.reason.endsWith(why));
  }
  // "none" is always offered, as a value and as a recall
  const ok = new Cassette(
    recorded({ turns: [{ ...turn0, value: [["none", 1]] }], recall: [["none", 1]] }),
    "m",
    "none",
  ).step("S: x", scripted({}).live);
  await ok.turn("x", page, []);
  assert.equal((await ok.value("x", page, page.elements[0], [])).choice, "none");
  assert.equal((await ok.recall("x", {})).choice, "none");
});

test("cassette: 'none' and the page are offered targets; a pinned turn replays confirmed; an action the target can do is kept", async () => {
  const p = recorded({
    confidence: { target: 0.4, answer: 0.7 },
    turns: [
      {
        done: 0,
        target: [
          ["page", 0.6],
          ["none", 0.4],
        ],
        action: [["scroll down", 1]],
      },
      { done: 0, target: [[{ role: "textbox", name: "Name", container: "" }, 1]], action: [["enter", 1]] },
    ],
    pinned: [{ turn: 2, candidate: 1, resolution: saveTarget, original: [] }],
  });
  const d = new Cassette(p, "m", "none").step("S: x", scripted({}).live);
  const t1 = await d.turn("x", page, []);
  assert.deepEqual(t1.target.probabilities, { page: 0.6, none: 0.4 });
  assert.equal(t1.target.confirmed, undefined);
  assert.deepEqual(t1.target.recordedConfidence, { target: 0.4, answer: 0.7 });
  const t2 = await d.turn("x", page, []);
  assert.equal(t2.target.confirmed, true);
  assert.equal(t2.action?.choice, "enter");
});

test("cassette: in new mode a broken replay heals live once, logs it and writes the Step back", async () => {
  const p = recorded({ turns: [{ done: 0, target: [[{ role: "button", name: "Gone", container: "" }, 1]] }] });
  const log: string[] = [];
  const answer = { done: 0, target: sure("e2"), action: pick({ click: 0.6, type: 0.4 }) };
  const { live, calls } = scripted({ turn: answer, recall: sure("Ada") });
  const c = new Cassette(p, "m", "new");
  const d = c.step("S: x", live, (l) => log.push(l));
  assert.equal(await d.turn("x", page, []), answer);
  await d.recall("x", { Ada: "s" });
  assert.deepEqual(calls, ["turn", "recall"]);
  assert.deepEqual(log, [`  (cassette: healing, button "Gone" matches 0 elements now, needs exactly 1)`]);
  assert.equal(d.done(true), "healed");
  assert.equal(c.healed, 1);
  assert.equal(log.at(-1), "  (cassette: healed, written back)");
  c.save();
  // The action stored is restricted to what the button can do.
  assert.deepEqual(read(p).entries["S: x"].turns[0].action, [["click", 0.6]]);
  assert.deepEqual(read(p).entries["S: x"].turns[0].target, [[saveTarget, 1]]);
});

test("cassette: an uncertain target stores the top three, a confident one only what covers the gate", async () => {
  const p = tmp();
  const c = new Cassette(p, "m", "new");
  const wide = pick({ e1: 0.45, e2: 0.4, page: 0.1, none: 0.05 });
  const d = c.step("S: x", scripted({ turn: { done: 0, target: wide } }).live);
  await d.turn("x", page, []);
  d.done(true);
  const e = c.step("S: y", scripted({ turn: { done: 0, target: pick({ e2: 0.85, e1: 0.15 }) } }).live);
  await e.turn("x", page, []);
  e.done(true);
  c.save();
  assert.deepEqual(
    read(p).entries["S: x"].turns[0].target.map(([t]: [{ name: string } | string]) =>
      typeof t === "string" ? t : t.name,
    ),
    ["Name", "Save", "page"], // non-element answers are kept as is
  );
  assert.deepEqual(read(p).entries["S: y"].turns[0].target, [[saveTarget, 0.85]]);
});

test("cassette: a Step that errored, a judged check, or a replay-only Step asking nothing are not written", async () => {
  const p = tmp();
  const c = new Cassette(p, "m", "new");
  const { live, calls } = scripted({ recall: sure("Ada"), assess: { kind: sure("fuzzy"), judged: 0.9 } });
  const err = c.step("S: err", live);
  await err.recall("x", { Ada: "s" });
  assert.equal(err.done(false), undefined);
  const judged = c.step("S: judged", live);
  await judged.assess("x", page, true);
  assert.equal(judged.done(true), undefined);
  c.save();
  assert.throws(() => readFileSync(p));
  assert.deepEqual(calls, ["recall", "assess"]);
  // judged replays live even with a recorded check
  const q = recorded({ check: { kind: sure("value"), state: sure("x"), subject: [["none", 1]], area: [["page", 1]] } });
  const s = scripted({ assess: { kind: sure("fuzzy"), judged: 0.2 } });
  const jd = new Cassette(q, "m", "new").step("S: x", s.live);
  assert.equal((await jd.assess("x", page, true)).judged, 0.2);
  assert.equal(jd.done(true), undefined);
});

test("cassette: all mode re-records over a file from an earlier run, keeps this run's other entries", async () => {
  const p = recorded({ recall: [["Old", 1]] });
  const { live, calls } = scripted({ recall: sure("New"), intent: { attempt: true } });
  const c = new Cassette(p, "m2", "all", "run1");
  const d = c.step("S: x", live);
  assert.equal((await d.recall("x", { New: "s" })).choice, "New");
  assert.deepEqual(await d.intent!("x", false), { attempt: true });
  assert.equal(d.done(true), "recorded");
  // another worker of this run saved meanwhile
  writeFileSync(p, JSON.stringify({ model: "m2", run: "run1", entries: { "S: other": { recall: [["O", 1]] } } }));
  c.save();
  const file = read(p);
  assert.equal(file.run, "run1");
  assert.equal(file.model, "m2");
  assert.deepEqual(Object.keys(file.entries).sort(), ["S: other", "S: x"]);
  assert.equal(file.entries["S: x"].intent.attempt, true);
  assert.deepEqual(calls, ["recall", "intent"]);
  // a stale file alone in all mode is rewritten without its entries even with no Step recorded
  const q = recorded({ recall: [["Old", 1]] });
  new Cassette(q, "m", "all", "run2").save();
  assert.deepEqual(read(q).entries, {});
  // ...but kept when another run's worker merged and this run wrote it
  const r = recorded({ recall: [["Old", 1]] });
  writeFileSync(r, JSON.stringify({ model: "m", run: "run3", entries: { "S: x": { recall: [["Old", 1]] } } }));
  const same = new Cassette(r, "m", "all", "run3");
  same.save();
  assert.deepEqual(Object.keys(read(r).entries), ["S: x"]);
  // replay-only never rewrites a stale file
  const n = recorded({ recall: [["Old", 1]] });
  const before = readFileSync(n, "utf8");
  new Cassette(n, "m", "none", "run4").save();
  assert.equal(readFileSync(n, "utf8"), before);
});

test("cassette: in new mode an intent replays only from an unbroken recorded Step; a broken one asks live", async () => {
  const p = recorded({ intent: { exact: true } });
  const { live, calls } = scripted({ intent: { attempt: true }, recall: sure("A") });
  const d = new Cassette(p, "m", "new").step("S: x", live);
  assert.deepEqual(await d.intent!("x", true), { exact: true });
  await d.recall("x", { A: "s" });
  assert.deepEqual(await d.intent!("x", true), { attempt: true });
  const none = new Cassette(tmp(), "m", "new").step("S: y", { ...live, intent: undefined } as Decider);
  assert.deepEqual(await none.intent!("x", true), {});
  assert.deepEqual(calls, ["recall", "intent"]);
});

test("cassette: an unreadable file says which one and how to recover", () => {
  const p = tmp();
  writeFileSync(p, "{oops");
  assert.throws(
    () => new Cassette(p, "m", "new"),
    /^Error: Cannot read cassette .*t\.cassette\.json: .+\. Delete it to record again\.$/,
  );
});

test("cassette: a recorded answer keeps the confidence it was recorded with across a heal", async () => {
  const p = tmp();
  const c = new Cassette(p, "m", "new");
  const conf = { target: 0.3, answer: 0.6 };
  const d = c.step("S: x", scripted({ recall: { ...sure("A"), recordedConfidence: conf } }).live);
  await d.recall("x", { A: "s" });
  d.done(true);
  c.save();
  assert.deepEqual(read(p).entries["S: x"].recall, [["A", 1, conf]]);
  const r = await new Cassette(p, "m", "none").step("S: x", scripted({}).live).recall("x", { A: "s" });
  assert.deepEqual(r.recordedConfidence, conf);
});

const ambiguous = (role = "textbox", extra: Record<string, unknown> = {}) =>
  recorded({
    turns: [
      {
        done: 0,
        target: [
          [{ role: "button", name: "Wrong", container: "" }, 0.47],
          [{ role, name: "Right", container: "" }, 0.4],
          ["none", 0.13],
        ],
        action: [["click", 1]],
        ...extra,
      },
    ],
  });

test("resolutions: lists an ambiguous single action's element candidates; none for other Steps", () => {
  const c = new Cassette(ambiguous(), "m", "none");
  assert.deepEqual(c.resolutions("S: x", action(`I type "Ada" into a field`)), [
    `1. button "Wrong" (47%)`,
    `2. textbox "Right" (40%)`,
  ]);
  assert.deepEqual(c.resolutions("S: x", action("I click a button and submit")), []);
  assert.deepEqual(c.resolutions("S: x", action("I click the button", "assertion")), []);
  assert.deepEqual(c.resolutions("S: missing", action("I click the button")), []);
  const sureFile = recorded({
    turns: [
      {
        done: 0,
        target: [
          [saveTarget, 0.9],
          ["none", 0.1],
        ],
      },
    ],
  });
  assert.deepEqual(new Cassette(sureFile, "m", "none").resolutions("S: x", action("I click Save")), []);
  const doneFile = recorded({
    turns: [
      {
        done: 0.9,
        target: [
          [saveTarget, 0.47],
          ["none", 0.4],
        ],
      },
    ],
  });
  assert.deepEqual(new Cassette(doneFile, "m", "none").resolutions("S: x", action("I click Save")), []);
  const dialogFile = recorded({ turns: [{ dialog: [["accept", 0.5]] }] });
  assert.deepEqual(new Cassette(dialogFile, "m", "none").resolutions("S: x", action("I click Save")), []);
});

test("singleAction grammar: which Step wordings are one explicit action", () => {
  const c = new Cassette(ambiguous(), "m", "none");
  const ok = (text: string) => c.resolutions("S: x", action(text)).length > 0;
  for (const text of [
    "I click the button",
    "click on a link",
    `I click "Save"`,
    `I click the "Save" button in the "Form" dialog`,
    `I click "Save" in "Form"`,
    "I double-click an item",
    "I right-click the option",
    `I hover over "Menu"`,
    `I type "x" into the field`,
    `I type “x” in a searchbox`,
    `I fill the field with "x"`,
    `I fill "Name"`,
    `I select "x" from the combobox`,
    `I select "x" in "Country"`,
    `I upload "f.txt" to the control`,
    `I CLICK THE BUTTON`,
    `I fill the field in "Billing"`,
  ])
    assert.ok(ok(text), text);
  for (const text of [
    "I click the button and wait",
    "I press the button",
    `I type "x"`,
    `I select "x"`,
    `I upload "f"`,
    "I hover the menu",
    "I click",
    "I clicked the button",
    `I click "a" in "b" panel`,
  ])
    assert.ok(!ok(text), text);
});

test("pin: confirms one candidate in the cassette, with the action and a quoted value", () => {
  const p = ambiguous();
  const r = pin(p, "S: x", 2, action(`I type "Ada" into a field`));
  assert.deepEqual(r, { role: "textbox", name: "Right", container: "" });
  const t = read(p).entries["S: x"];
  assert.deepEqual(t.turns[0].target, [[r, 1]]);
  assert.deepEqual(t.turns[0].action, [["type", 1]]);
  assert.deepEqual(t.turns[0].value, [["Ada", 1]]);
  assert.deepEqual(t.pinned, [
    {
      turn: 1,
      candidate: 2,
      resolution: r,
      original: [
        [{ role: "button", name: "Wrong", container: "" }, 0.47],
        [r, 0.4],
        ["none", 0.13],
      ],
    },
  ]);
  const f = ambiguous();
  pin(f, "S: x", 2, action(`I fill a field with “Bo”`));
  assert.deepEqual(read(f).entries["S: x"].turns[0].value, [["Bo", 1]]);
  const v = ambiguous("textbox", { value: [["Kept", 1]] });
  pin(v, "S: x", 2, action(`I fill a field`.replace("fill a field", `fill the field with "New"`)));
  assert.deepEqual(read(v).entries["S: x"].turns[0].value, [["Kept", 1]]);
  const b = ambiguous();
  assert.deepEqual(pin(b, "S: x", 1, action("I double-click a button")), {
    role: "button",
    name: "Wrong",
    container: "",
  });
  assert.deepEqual(read(b).entries["S: x"].turns[0].action, [["double click", 1]]);
  assert.equal(read(b).entries["S: x"].turns[0].value, undefined);
  for (const [verb, want] of [
    ["right-click", "right click"],
    ["hover over", "hover"],
  ]) {
    const h = ambiguous();
    pin(h, "S: x", 1, action(`I ${verb} a button`));
    assert.deepEqual(read(h).entries["S: x"].turns[0].action, [[want, 1]]);
  }
  assert.match(readFileSync(b, "utf8"), /^\{\n {2}"model": "m",\n {2}"entries": \{\n {4}"S: x": /);
});

test("pin: refuses a missing candidate, an unknown wording, a target that cannot act, a value with no quote", () => {
  const cases: [string, number, ParsedStep, RegExp, string?][] = [
    ["S: x", 0, action("I click a button"), /^Error: Choose an available Resolution \(1-3\)/],
    ["S: x", 3, action("I click a button"), /^Error: Choose an available Resolution/],
    ["S: x", 1.5, action("I click a button"), /^Error: Choose an available Resolution/],
    ["S: nope", 1, action("I click a button"), /^Error: Choose an available Resolution/],
    ["S: x", 1, action("I click a button and go"), /^Error: Pin requires an explicit single action/],
    [
      "S: x",
      1,
      action(`I type "a" into a field`),
      /^Error: The chosen Resolution cannot perform type\. Cassette unchanged\.$/,
    ],
    ["S: x", 2, action(`I upload "a" to a field`), /^Error: The chosen Resolution cannot perform upload/],
    [
      "S: x",
      2,
      action("I fill a field with Ada".replace("with Ada", "")),
      /^Error: This target needs an unrecorded value/,
    ],
  ];
  for (const [key, n, step, err] of cases) {
    const p = ambiguous();
    const before = readFileSync(p, "utf8");
    assert.throws(() => pin(p, key, n, step), err, step.text);
    assert.equal(readFileSync(p, "utf8"), before);
  }
  const s = ambiguous("combobox");
  assert.throws(() => pin(s, "S: x", 2, action(`I type "a" into the combobox`)), /cannot perform type/);
});

const goneTarget = { role: "button", name: "Dry run ● Running", container: "" };

test("cassette: a recorded candidate that is gone only counts through its probability; the top is still required", async () => {
  // A transient label ("Running") that was a second candidate when recorded: replay-only must not need it.
  const p = recorded({
    turns: [
      {
        done: 0.72,
        target: [
          ["none", 0.59],
          [goneTarget, 0.33],
        ],
        action: [["wait", 0.68]],
      },
    ],
  });
  const a = await new Cassette(p, "m", "none").step("S: x", scripted({}).live).turn("x", page, []);
  assert.equal(a.target.choice, "none");
  assert.deepEqual(Object.values(a.target.probabilities).sort(), [0.33, 0.59]);
  // Not leniency: the gone candidate's mass still narrows the margin exactly as when it was recorded.
  assert.equal(gate(a.target, 0.5, 0.25), true);
  assert.equal(gate(a.target, 0.5, 0.27), false);
  assert.match(fmt(a.target), /button "Dry run ● Running" \(not on the page now\)=0.33/);
  assert.match(named(a.target, page), /button "Dry run ● Running" \(not on the page now\) 33%/);
  assert.ok(!(fmt(a.target) + named(a.target, page)).includes("\u0000"));

  // A close second that is gone leaves the recorded ambiguity as it was: still under the target gate (margin 0.1).
  const close = recorded({
    turns: [
      {
        done: 0,
        target: [
          [saveTarget, 0.5],
          [goneTarget, 0.45],
        ],
      },
    ],
  });
  const b = await new Cassette(close, "m", "none").step("S: x", scripted({}).live).turn("x", page, []);
  assert.equal(b.target.choice, "e2");
  assert.equal(gate(b.target, 0.5, 0.1), false);

  // The top is acted on, so it must exist: it is waited for, then UI_CHANGED.
  const top = recorded({
    turns: [
      {
        done: 0,
        target: [
          [goneTarget, 0.9],
          [saveTarget, 0.05],
        ],
      },
    ],
  });
  await assert.rejects(new Cassette(top, "m", "none").step("S: x", scripted({}).live).turn("x", page, []), NotYet);

  // A Step recorded as done acts on no target at all.
  const done = recorded({
    turns: [
      {
        done: 0.97,
        target: [
          [goneTarget, 0.6],
          ["none", 0.3],
        ],
      },
    ],
  });
  const c = await new Cassette(done, "m", "none").step("S: x", scripted({}).live).turn("x", page, []);
  assert.equal(c.done, 0.97);
});

test("cassette: a check still needs every plausible subject; a heal writes a gone candidate back as its Resolution", async () => {
  const check = recorded({
    check: {
      kind: [["presence", 1]],
      state: [["none", 1]],
      subject: [
        [saveTarget, 0.5],
        [goneTarget, 0.45],
      ],
      area: [["page", 1]],
    },
  });
  await assert.rejects(
    new Cassette(check, "m", "none").step("S: x", scripted({}).live).assess("x", page, false),
    NotYet,
  );

  const p = recorded({
    turns: [
      {
        done: 0,
        target: [
          [saveTarget, 0.5],
          [goneTarget, 0.45],
        ],
      },
    ],
  });
  const { live } = scripted({ turn: { done: 0.9, target: sure("none") } });
  const c = new Cassette(p, "m", "new");
  const d = c.step("S: x", live);
  await d.turn("x", page, []); // replayed, with the gone candidate
  await d.turn("x", page, []); // turn 2 was never recorded: live, the Step heals
  d.done(true);
  c.save();
  const written = read(p).entries["S: x"].turns[0].target;
  assert.deepEqual(
    written.map(([t]: [unknown]) => t),
    [saveTarget, goneTarget],
  );
});
