// Builds the docs site into site/*.html (task 0050): static pages with relative links, so it opens from file:// and
// deploys to GitHub Pages as is. Sources: docs/site/*.md, docs/cookbook.md, docs/configuration.md, the agent skill and
// the example features. Run: node scripts/site.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Marked } from "marked";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const NAV: [group: string, pages: [slug: string, title: string, source: string][]][] = [
  ["Getting started", [["index", "Introduction", "docs/site/index.md"], ["installation", "Installation", "docs/site/installation.md"],
    ["quick-start", "Quick start", "docs/site/quick-start.md"]]],
  ["Usage", [["writing-features", "Writing features", "docs/site/writing-features.md"], ["cli", "Command line", "docs/site/cli.md"],
    ["record-replay", "Record and replay", "docs/site/record-replay.md"], ["configuration", "Configuration", "docs/configuration.md"],
    ["reports", "Reports and debugging", "docs/site/reports.md"], ["ci", "CI", "docs/site/ci.md"],
    ["cucumber-js", "Running with cucumber-js", "docs/site/cucumber-js.md"]]],
  ["Guides", [["cookbook", "Step cookbook", "docs/cookbook.md"], ["agent-skill", "Agent skill", "skills/decisium/SKILL.md"]]],
  ["Reference", [["examples", "Examples", ""]]],
];
const slugs = new Set(NAV.flatMap(([, ps]) => ps.map(([s]) => s)));

export const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>|&\w+;/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A link from a source page to its place in the site; undefined drops the link and keeps its text. */
export function siteHref(href: string): string | undefined {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const example = /(?:^|\/)examples\/(?:[\w-]+\/)*([\w-]+)\.feature(?:#L(\d+))?$/.exec(href);
  if (example) return `examples.html#${example[1]}${example[2] ? `-L${example[2]}` : ""}`;
  const page = /^(?:\.\/|\.\.\/)?(?:docs\/)?([\w-]+)\.md(#.*)?$/.exec(href);
  if (page && slugs.has(page[1])) return `${page[1]}.html${page[2] ?? ""}`;
  return undefined;
}

function render(md: string) {
  const toc: { level: number; id: string; text: string }[] = [];
  const marked = new Marked({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = slugify(text);
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, text: text.replace(/<[^>]+>/g, "") });
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      link({ href, tokens }) {
        const text = this.parser.parseInline(tokens);
        const to = siteHref(href);
        return to === undefined ? text : `<a href="${to}">${text}</a>`;
      },
    },
  });
  return { html: marked.parse(md) as string, toc };
}

/** The examples page: every example feature with an anchor per line, the targets of the cookbook's links. */
function examples() {
  const dirs = ["examples/cookbook", "examples/campaign-manager", "examples/campaign-app"];
  const files = dirs.flatMap(d => (readdirSync(join(root, d)).filter(f => f.endsWith(".feature")).map(f => `${d}/${f}`)))
    .concat("examples/campaign-app.feature").filter((f, i, all) => all.indexOf(f) === i).filter(f => { try { read(f); return true; } catch { return false; } });
  let md = "# Examples\n\nThe features behind the [Cookbook](cookbook.md). Each one runs from its committed cassette with " +
    "`--record none`. Scenarios marked \"Should FAIL\" show a wording the cookbook warns against.\n\n";
  const toc: { level: number; id: string; text: string }[] = [];
  const blocks = files.map(f => {
    const name = basename(f, ".feature");
    toc.push({ level: 2, id: name, text: `${name}.feature` });
    const lines = read(f).split("\n").map((l, i) => `<span class="ln" id="${name}-L${i + 1}"><a href="#${name}-L${i + 1}">${i + 1}</a>${esc(l)}</span>`);
    return `<h2 id="${name}">${name}.feature</h2>\n<p class="path">${f}</p>\n<pre class="feature"><code>${lines.join("")}</code></pre>`;
  });
  return { html: render(md).html + blocks.join("\n"), toc };
}

function source(path: string) {
  let md = read(path).replace(/^---\n[\s\S]*?\n---\n/, ""); // front matter
  if (path.startsWith("skills/")) md = "# Agent skill\n\nInstall it into your coding agent from `node_modules/decisium/skills/decisium/SKILL.md`.\n\n" +
    md.replace(/node src\/cli\.ts/g, "npx decisium");
  return md;
}

const MARK = (size: number) => `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><path d="M8 8H30A24 24 0 0 1 30 56H8ZM31 19L44 32L31 45L18 32Z" fill="currentColor" fill-rule="evenodd"/><path d="M31 22L41 32L31 42L21 32Z" fill="var(--a)"/></svg>`;
const WORDMARK = `<span class="wordmark" aria-label="decisium">dec<span class="i">ı</span>s<span class="i">ı</span>um</span>`;

function page(slug: string, title: string, html: string, toc: { level: number; id: string; text: string }[]) {
  const nav = NAV.map(([group, ps]) => `<div class="nav-group"><span class="nav-title">${group}</span>${ps.map(([s, t]) =>
    `<a href="${s}.html"${s === slug ? ' aria-current="page"' : ""}>${t}</a>`).join("")}</div>`).join("");
  const flat = NAV.flatMap(([, ps]) => ps), i = flat.findIndex(([s]) => s === slug);
  const pager = [flat[i - 1] && `<a class="prev" href="${flat[i - 1][0]}.html"><span>Previous</span>${flat[i - 1][1]}</a>`,
    flat[i + 1] && `<a class="next" href="${flat[i + 1][0]}.html"><span>Next</span>${flat[i + 1][1]}</a>`].filter(Boolean).join("");
  const onPage = toc.length > 1 ? `<aside class="toc"><span class="nav-title">On this page</span>${toc.map(h =>
    `<a class="l${h.level}" href="#${h.id}">${esc(h.text)}</a>`).join("")}</aside>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${slug === "index" ? "Decisium" : `${title} · Decisium`}</title>
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="assets/nocturne.css">
<link rel="stylesheet" href="assets/site.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="index.html">${MARK(24)}${WORDMARK}</a>
  <nav class="top-links"><a href="https://www.npmjs.com/package/decisium">npm</a></nav>
</header>
<div class="layout">
<nav class="sidebar">${nav}</nav>
<main class="doc">${html}<div class="pager">${pager}</div></main>
${onPage}
</div>
</body>
</html>
`;
}

if (import.meta.main) {
  for (const [slug, title, path] of NAV.flatMap(([, ps]) => ps)) {
    const { html, toc } = slug === "examples" ? examples() : render(source(path));
    writeFileSync(join(root, "site", `${slug}.html`), page(slug, title, html, toc));
  }
  console.log(`site/: ${slugs.size} pages`);
}
