// Docs search over window.SEARCH_INDEX (built by scripts/site.ts): every word must match; headings rank first.
(() => {
  const input = document.getElementById("search"), box = document.querySelector(".search-results");
  const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const mark = (s, words) => words.reduce((h, w) => h.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>"), esc(s));
  let hits = [], active = 0;

  function search(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return (window.SEARCH_INDEX || []).map(e => {
      const head = `${e.page} ${e.section}`.toLowerCase(), body = e.text.toLowerCase();
      if (!words.every(w => head.includes(w) || body.includes(w))) return null;
      const score = words.reduce((n, w) => n + (e.section.toLowerCase().includes(w) ? 10 : head.includes(w) ? 5 : 1), 0);
      const found = words.map(w => body.indexOf(w)).filter(i => i >= 0);
      const at = found.length ? Math.max(0, Math.min(...found) - 40) : 0; // heading-only match: start of the section
      const snippet = (at ? "…" : "") + e.text.slice(at, at + 140) + (e.text.length > at + 140 ? "…" : "");
      return { e, score, words, snippet };
    }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 8);
  }

  function show() {
    box.hidden = !input.value.trim();
    box.innerHTML = hits.length ? hits.map((h, i) => `<a href="${h.e.url}" role="option"${i === active ? ' aria-selected="true"' : ""}>
      <span class="r-title">${esc(h.e.page)}${h.e.section ? ` › ${mark(h.e.section, h.words)}` : ""}</span>
      <span class="r-text">${mark(h.snippet, h.words)}</span></a>`).join("") : `<p class="r-none">No results</p>`;
  }

  input.addEventListener("input", () => { hits = search(input.value); active = 0; show(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % Math.max(hits.length, 1); show(); }
    else if (e.key === "Enter" && hits[active]) box.querySelectorAll("a")[active].click();
    else if (e.key === "Escape") { input.value = ""; box.hidden = true; input.blur(); }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "/" && document.activeElement !== input && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
  });
  document.addEventListener("click", e => { if (!e.target.closest(".search")) box.hidden = true; });
})();
