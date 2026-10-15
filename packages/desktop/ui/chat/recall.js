import { el as node } from "../dom.js";
// Composer recall: while a prompt is typed, the session project's findings
// and truths that match it, as up to three chips above the editor. A click
// adds the finding to the prompt. Plain browser ES module; the pure helpers
// carry no DOM so they import and test in Node.

import { freshnessChip } from "../citation-freshness.js";
import { hookGet } from "../api.js";

const DEBOUNCE_MS = 500;
const MIN_WORDS = 3;
const MIN_SCORE = 0.3;
const SHOWN = 3;

/** The search for a draft, or "" when it is too short or a slash command. */
export function recallQuery(draft) {
  const text = String(draft || "").trim();
  if (!text || text.startsWith("/")) return "";
  const words = text.split(/\s+/);
  if (words.length < MIN_WORDS) return "";
  return words.slice(-40).join(" ");
}

/** The hits worth showing: confident ones the prompt doesn't already carry. */
export function recallHits(results, draft) {
  const carried = String(draft || "");
  return (results || [])
    .filter((hit) => hit && hit.text && (hit.score ?? 0) >= MIN_SCORE && !carried.includes(hit.text))
    .slice(0, SHOWN);
}

/** The draft with a remembered line appended. */
export function withRecall(draft, text) {
  const base = String(draft || "").replace(/\s+$/, "");
  return `${base}${base ? "\n\n" : ""}Phren remembers: ${text}`;
}

/** The chip strip. `draft()` reads the editor, `attach(text)` replaces it. */
export function createRecall({ computer, project, draft, attach }) {
  const el = node("div", "pc-recall");
  el.hidden = true;
  let timer = null;
  let asked = "";
  let dismissed = false; // until the prompt is sent or cleared
  let results = [];

  function render() {
    const hits = asked && !dismissed ? recallHits(results, draft()) : [];
    el.replaceChildren();
    el.hidden = !hits.length;
    if (!hits.length) return;
    el.append(node("span", "pc-recall-label", "Phren remembers"));
    for (const hit of hits) {
      const chip = node("button", "pc-recall-chip");
      chip.type = "button";
      chip.title = `Add to the prompt: ${hit.text}`;
      chip.append(node("span", "pc-recall-icon", hit.kind === "truth" ? "★" : "◆"), node("span", "pc-recall-text", hit.text));
      const freshness = freshnessChip(hit.finding ?? hit, "pc-recall-freshness warn");
      if (freshness) chip.append(freshness);
      chip.onclick = () => { attach(withRecall(draft(), hit.text)); render(); };
      el.append(chip);
    }
    const close = node("button", "pc-recall-x", "×");
    close.type = "button";
    close.title = "Hide for this prompt";
    close.onclick = () => { dismissed = true; render(); };
    el.append(close);
  }

  /** Call on every edit; searches once typing pauses. */
  function update() {
    const query = project && computer ? recallQuery(draft()) : "";
    if (timer) clearTimeout(timer);
    if (!query) { asked = ""; results = []; if (!draft().trim()) dismissed = false; render(); return; }
    render();
    if (query === asked) return;
    timer = setTimeout(async () => {
      let body = null;
      try {
        body = await hookGet(computer, `/v1/projects/${encodeURIComponent(project)}/memory/search`, { q: query, limit: "6" });
      } catch { /* an older Hook or a read that failed: no chips */ }
      if (recallQuery(draft()) !== query) return;
      asked = query;
      results = (body && body.results) || [];
      render();
    }, DEBOUNCE_MS);
  }

  return { el, update, destroy() { if (timer) clearTimeout(timer); } };
}
