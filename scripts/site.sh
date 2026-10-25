#!/usr/bin/env bash
# Stages the docs site into $1 (default _site_src): site/ plus README and docs pages, given front matter and .html links
# so a plain Jekyll build renders them. The release workflow builds the result with actions/jekyll-build-pages.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/_site_src}
rm -rf "$out" && cp -R "$root/site" "$out" && mkdir -p "$out/docs"
page() { { printf -- '---\n---\n'; sed -E 's/\]\(([^):#]+)\.md(#[^)]*)?\)/](\1.html\2)/g' "$1"; } > "$2"; }
page "$root/README.md" "$out/readme.md"
for f in configuration cookbook; do page "$root/docs/$f.md" "$out/docs/$f.md"; done
