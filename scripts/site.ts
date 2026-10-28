// Builds the docs site into site/*.html (task 0050): static pages with relative links, so it opens from file:// and
// deploys to GitHub Pages as is. Sources: docs/site/*.md, docs/configuration.md, the agent skill and
// the example features. Run: node scripts/site.ts
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Marked } from "marked";

const REPO = "https://github.com/andletenkov/decisium";
const VERSION: string = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version; // the release being documented

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const NAV: [group: string, pages: [slug: string, title: string, source: string][]][] = [
  [
    "Getting started",
    [
      ["index", "Introduction", "docs/site/index.md"],
      ["installation", "Installation", "docs/site/installation.md"],
      ["quick-start", "Quick start", "docs/site/quick-start.md"],
    ],
  ],
  [
    "Writing tests",
    [
      ["writing-features", "Features and scenarios", "docs/site/writing-features.md"],
      ["steps", "Writing Steps", "docs/site/steps.md"],
      ["how-it-works", "How a Step runs", "docs/site/how-it-works.md"],
      ["browser-context", "Browser context", "docs/site/browser-context.md"],
      ["client-steps", "Client steps", "docs/site/client-steps.md"],
    ],
  ],
  [
    "Running",
    [
      ["cli", "Command line", "docs/site/cli.md"],
      ["record-replay", "Record and replay", "docs/site/record-replay.md"],
      ["network-replay", "Network replay", "docs/site/network-replay.md"],
      ["configuration", "Configuration", "docs/configuration.md"],
      ["reports", "Reports and debugging", "docs/site/reports.md"],
      ["ci", "CI", "docs/site/ci.md"],
      ["cucumber-js", "Running with cucumber-js", "docs/site/cucumber-js.md"],
    ],
  ],
  [
    "Guides",
    [
      ["troubleshooting", "Troubleshooting", "docs/site/troubleshooting.md"],
      ["agent-skill", "Agent skill", "skills/decisium/SKILL.md"],
    ],
  ],
  ["Reference", [["examples", "Examples", ""]]],
];
const slugs = new Set(NAV.flatMap(([, ps]) => ps.map(([s]) => s)));

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>|&\w+;/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A link from a source page to its place in the site; undefined drops the link and keeps its text. */
export function siteHref(href: string): string | undefined {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const example = /(?:^|\/)((?:examples|test\/fixtures)\/[\w./-]+\.(?:feature|ts|html))(#L\d+)?$/.exec(href);
  if (example) return `${REPO}/blob/main/${example[1]}${example[2] ?? ""}`; // a source file, on GitHub
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

/** Real public sites a user can run as is, each replaying from its committed cassette. */
const EXAMPLES: [file: string, about: string][] = [
  ["examples/saucedemo.feature", "A shop: login, a locked-out user, sorting, the cart and checkout validation."],
  ["examples/todomvc.feature", "List state: a Background, counters, filters and absence checks scoped to the list."],
  ["examples/the-internet.feature", "Classic widgets: checkboxes, dropdowns, and a start URL per scenario."],
  ["examples/github.feature", "A large live site with no login: tabs, headings and releases."],
];

/** The examples page: the EXAMPLES features with an anchor per line. */
function examples() {
  const md =
    "# Examples\n\nFeatures against real public sites. Copy one into your project and run it:\n\n" +
    "```sh\nnpx decisium run saucedemo.feature\n```\n\nThe first run calls Jev and writes `saucedemo.cassette.json` next to it; " +
    "after that, `--record none` replays it with no model calls. How to word each kind of Step is in " +
    "[Writing Steps](steps.md).\n";
  const toc: { level: number; id: string; text: string }[] = [];
  const blocks = EXAMPLES.map(([f, about]) => {
    const name = basename(f, ".feature");
    toc.push({ level: 2, id: name, text: `${name}.feature` });
    const lines = read(f)
      .split("\n")
      .map(
        (l, i) => `<span class="ln" id="${name}-L${i + 1}"><a href="#${name}-L${i + 1}">${i + 1}</a>${esc(l)}</span>`,
      );
    return `<h2 id="${name}">${name}.feature</h2>\n<p>${about} <a href="${REPO}/blob/main/${f}">Source</a></p>\n<pre class="feature"><code>${lines.join("")}</code></pre>`;
  });
  return { html: render(md).html + blocks.join("\n"), toc };
}

function source(path: string) {
  let md = read(path).replace(/^---\n[\s\S]*?\n---\n/, ""); // front matter
  if (path.startsWith("skills/"))
    md =
      "# Agent skill\n\nInstall it into your coding agent from `node_modules/decisium/skills/decisium/SKILL.md`.\n\n" +
      md;
  return md;
}

// Theme: ?theme= (carried on internal links), else localStorage, else the system. The link carries it because Safari
// keeps a separate localStorage per file:// page.
const THEME_JS = `const q = new URLSearchParams(location.search).get("theme");
let saved = null; try { saved = localStorage.getItem("theme"); } catch {}
document.documentElement.dataset.theme = q || saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem("theme", t); } catch {} }
document.addEventListener("click", e => { const a = e.target.closest("a[href]"); if (!a || /^(https?:|#)/.test(a.getAttribute("href"))) return;
  const u = new URL(a.href); u.searchParams.set("theme", document.documentElement.dataset.theme); a.href = u.href; });`;
const GITHUB = `<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;
const NPM = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z"/></svg>`;
const MOON = `<svg class="moon" width="16" height="16" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M233.5 137.9a8 8 0 0 0-10-5.7A88 88 0 0 1 123.8 32.5a8 8 0 0 0-10-10A104.1 104.1 0 1 0 233.5 147.9a8 8 0 0 0 0-10Z"/></svg>`;
const SUN = `<svg class="sun" width="16" height="16" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128 64a64 64 0 1 0 64 64 64.1 64.1 0 0 0-64-64Zm-8-24V16a8 8 0 0 1 16 0v24a8 8 0 0 1-16 0Zm0 200v-24a8 8 0 0 1 16 0v24a8 8 0 0 1-16 0ZM40 136H16a8 8 0 0 1 0-16h24a8 8 0 0 1 0 16Zm208-8a8 8 0 0 1-8 8h-24a8 8 0 0 1 0-16h24a8 8 0 0 1 8 8ZM58.3 69.7l-16-16a8 8 0 0 1 11.4-11.4l16 16a8 8 0 0 1-11.4 11.4Zm139.4 0a8 8 0 0 1 0-11.4l16-16a8 8 0 0 1 11.4 11.4l-16 16a8 8 0 0 1-11.4 0ZM69.7 186.3a8 8 0 0 1 0 11.4l-16 16a8 8 0 0 1-11.4-11.4l16-16a8 8 0 0 1 11.4 0Zm144 16a8 8 0 0 1-11.4 11.4l-16-16a8 8 0 0 1 11.4-11.4Z"/></svg>`;
const MARK = (size: number) =>
  `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><path d="M8 8H30A24 24 0 0 1 30 56H8ZM31 19L44 32L31 45L18 32Z" fill="currentColor" fill-rule="evenodd"/><path d="M31 22L41 32L31 42L21 32Z" fill="var(--a)"/></svg>`;
const WORDMARK = `<span class="wordmark" aria-label="decisium">dec<span class="i">ı</span>s<span class="i">ı</span>um</span>`;

function page(slug: string, title: string, html: string, toc: { level: number; id: string; text: string }[]) {
  const nav = NAV.map(
    ([group, ps]) =>
      `<div class="nav-group"><span class="nav-title">${group}</span>${ps
        .map(([s, t]) => `<a href="${s}.html"${s === slug ? ' aria-current="page"' : ""}>${t}</a>`)
        .join("")}</div>`,
  ).join("");
  const flat = NAV.flatMap(([, ps]) => ps),
    i = flat.findIndex(([s]) => s === slug);
  const pager = [
    flat[i - 1] && `<a class="prev" href="${flat[i - 1][0]}.html"><span>Previous</span>${flat[i - 1][1]}</a>`,
    flat[i + 1] && `<a class="next" href="${flat[i + 1][0]}.html"><span>Next</span>${flat[i + 1][1]}</a>`,
  ]
    .filter(Boolean)
    .join("");
  const onPage =
    toc.length > 1
      ? `<aside class="toc"><span class="nav-title">On this page</span>${toc
          .map((h) => `<a class="l${h.level}" href="#${h.id}">${esc(h.text)}</a>`)
          .join("")}</aside>`
      : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${slug === "index" ? "Decisium" : `${title} · Decisium`}</title>
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="assets/nocturne.css">
<link rel="stylesheet" href="assets/site.css">
<script src="assets/search-index.js" defer></script>
<script src="assets/search.js" defer></script>
<script>${THEME_JS}</script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="index.html">${MARK(24)}${WORDMARK}</a>
  <div class="search"><input type="search" id="search" placeholder="Search docs" aria-label="Search docs" autocomplete="off"><kbd>/</kbd><div class="search-results" role="listbox" hidden></div></div>
  <nav class="top-links"><a class="icon-link" href="${REPO}" aria-label="GitHub" title="GitHub">${GITHUB}</a><a class="icon-link npm-version" href="https://www.npmjs.com/package/decisium" aria-label="npm, version ${VERSION}" title="npm">${NPM}<span>v${VERSION}</span></a>
    <button class="theme-toggle" type="button" aria-label="Switch light/dark theme" onclick="setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light')">${MOON}${SUN}</button></nav>
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

/** Search entries: one per page section (split at h2/h3), as plain text. */
export function searchEntries(slug: string, title: string, html: string) {
  const text = (h: string) =>
    h
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  return html
    .split(/(?=<h[23] id=")/)
    .map((part) => {
      const h = /^<h[23] id="([^"]+)">([\s\S]*?)<\/h[23]>/.exec(part);
      return {
        url: `${slug}.html${h ? `#${h[1]}` : ""}`,
        page: title,
        section: h ? text(h[2]) : "",
        text: text(h ? part.slice(h[0].length) : part).slice(0, 2000),
      };
    })
    .filter((e) => e.section || e.text);
}

if (import.meta.main) {
  const index: ReturnType<typeof searchEntries> = [];
  for (const [slug, title, path] of NAV.flatMap(([, ps]) => ps)) {
    const { html, toc } = slug === "examples" ? examples() : render(source(path));
    writeFileSync(join(root, "site", `${slug}.html`), page(slug, title, html, toc));
    index.push(...searchEntries(slug, title, html));
  }
  // A script, not JSON: fetch() is blocked on file://.
  writeFileSync(join(root, "site", "assets", "search-index.js"), `window.SEARCH_INDEX = ${JSON.stringify(index)};\n`);
  console.log(`site/: ${slugs.size} pages`);
}
