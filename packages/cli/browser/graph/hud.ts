import { KIND_COLORS, TOPIC_COLORS } from "./types.js";
import { bestSearchMatch, clamp, esc, recomputeSearchMatches, state, topicColor } from "./state.js";
import { applyHighlight } from "./nodes.js";
import { selectNode } from "./interactions.js";
import { applyFilters } from "./scene.js";

// HUD chrome: the filter bar keeps its exact contract data-attributes
// (hosts and e2e tests depend on them) but is restyled as holographic
// glass via injected CSS classes. Search no longer removes nodes — it
// dims non-matches (focus mode "search") and Enter flies to the best hit.

const HUD_CSS = `
#graph-filter .phren-hud-row{display:flex;align-items:center;gap:10px;flex-wrap:nowrap;width:100%}
.phren-hud-search{
  flex:1 1 auto;min-width:180px;padding:9px 14px;border-radius:8px;
  background:rgba(8,10,22,0.85);color:#dbe4ff;
  border:1px solid rgba(103,232,249,0.18);
  font:500 12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:0.03em;outline:none;transition:border-color 0.15s ease,box-shadow 0.15s ease;
}
.phren-hud-search::placeholder{color:#5b6488}
.phren-hud-search:focus{border-color:rgba(103,232,249,0.55);box-shadow:0 0 0 1px rgba(103,232,249,0.25),0 0 18px rgba(103,232,249,0.12)}
.phren-hud-btn{
  cursor:pointer;padding:9px 14px;border-radius:8px;
  border:1px solid rgba(103,232,249,0.18);background:rgba(8,10,22,0.85);
  font:650 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#dbe4ff;user-select:none;letter-spacing:0.06em;text-transform:uppercase;
  transition:border-color 0.15s ease;
}
.phren-hud-btn:hover{border-color:rgba(103,232,249,0.5)}
.phren-hud-counter{
  flex:0 0 auto;font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#8b96c9;white-space:nowrap;letter-spacing:0.05em;
  padding:6px 10px;border-radius:8px;background:rgba(8,10,22,0.6);
  border:1px solid rgba(103,232,249,0.1);
}
.phren-hud-panel{
  display:none;position:absolute;right:0;top:calc(100% + 8px);z-index:30;
  min-width:320px;max-height:420px;overflow:auto;padding:14px;
  border:1px solid rgba(103,232,249,0.22);border-radius:10px;
  background:rgba(8,10,22,0.94);box-shadow:0 12px 40px rgba(0,0,0,0.6),0 0 24px rgba(103,232,249,0.06);
  color:#dbe4ff;
}
.phren-hud-heading{
  font:700 9.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#67e8f9;text-transform:uppercase;letter-spacing:0.14em;margin:10px 0 6px;
}
.phren-hud-heading:first-child{margin-top:0}
.phren-hud-select{
  width:100%;padding:8px 10px;border-radius:6px;border:1px solid rgba(103,232,249,0.18);
  background:rgba(12,15,30,0.9);color:#dbe4ff;font-size:12px;margin-bottom:6px;
}
.phren-hud-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-bottom:6px}
.phren-hud-checklabel{display:flex;align-items:center;gap:8px;font-size:12px;color:#dbe4ff;cursor:pointer}
.phren-hud-dot{display:inline-block;width:9px;height:9px;border-radius:999px;flex:0 0 auto}
.phren-hud-limit{
  width:120px;padding:8px 10px;border-radius:6px;background:rgba(12,15,30,0.9);
  color:#dbe4ff;border:1px solid rgba(103,232,249,0.18);font-size:12px;
}
.phren-hud-stats{
  position:absolute;left:16px;bottom:14px;z-index:7;pointer-events:none;
  font:600 10px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#67e8f9;letter-spacing:0.14em;text-shadow:0 0 12px rgba(103,232,249,0.35);
  opacity:0.85;
}
.phren-hud-legend{
  position:absolute;right:16px;bottom:14px;z-index:7;display:flex;gap:6px;flex-wrap:wrap;
  justify-content:flex-end;max-width:46%;
}
.phren-legend-chip{
  display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;
  background:rgba(8,10,22,0.8);border:1px solid rgba(103,232,249,0.14);
  font:600 9.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#aeb7dd;letter-spacing:0.07em;text-transform:uppercase;cursor:pointer;
  user-select:none;transition:opacity 0.15s ease,border-color 0.15s ease;
}
.phren-legend-chip:hover{border-color:rgba(103,232,249,0.45)}
.phren-legend-chip.off{opacity:0.32}
`;

export function injectHudCss(): void {
  if (document.getElementById("phren-graph-hud-css")) return;
  const style = document.createElement("style");
  style.id = "phren-graph-hud-css";
  style.textContent = HUD_CSS;
  document.head.appendChild(style);
}

export function buildFilterBar(): void {
  const filterEl = document.getElementById("graph-filter");
  const projectFilterEl = document.getElementById("graph-project-filter");
  const limitRow = document.getElementById("graph-limit-row");
  if (!filterEl) return;
  injectHudCss();

  const projectNames = Array.from(new Set(
    state.rawNodes.filter((node) => node.kind === "project").map((node) => node.project || node.id)
  )).sort((a, b) => a.localeCompare(b));

  const storeNames = Array.from(new Set(
    state.rawNodes.map((node) => node.store).filter((store): store is string => Boolean(store))
  )).sort((a, b) => a.localeCompare(b));

  const typeDefs = [
    { key: "project", label: "Projects", color: KIND_COLORS.project },
    { key: "finding", label: "Findings", color: TOPIC_COLORS.general },
    { key: "task", label: "Tasks", color: KIND_COLORS["task-active"] },
    { key: "entity", label: "Fragments", color: KIND_COLORS.entity },
    { key: "reference", label: "Refs", color: KIND_COLORS.reference },
  ];

  const typeSection = typeDefs.map((typeDef) => (
    `<label class="phren-hud-checklabel">
      <input type="checkbox" data-filter-type-check="${typeDef.key}"${state.filterTypes[typeDef.key as keyof typeof state.filterTypes] ? " checked" : ""} />
      <span class="phren-hud-dot" style="background:${typeDef.color}"></span>
      <span>${esc(typeDef.label)}</span>
    </label>`
  )).join("");

  const topicSection = state.topics.map((topic) => (
    `<label class="phren-hud-checklabel">
      <input type="checkbox" data-filter-topic-check="${esc(topic.slug)}"${state.filterTopics[topic.slug] !== false ? " checked" : ""} />
      <span class="phren-hud-dot" style="background:${topicColor(topic.slug)}"></span>
      <span>${esc(topic.label)}</span>
    </label>`
  )).join("");

  const healthSection = [
    { key: "all", label: "All" },
    { key: "healthy", label: "Healthy" },
    { key: "decaying", label: "Decaying" },
    { key: "stale", label: "Stale" },
  ].map((entry) => (
    `<label class="phren-hud-checklabel">
      <input type="radio" name="graph-health-filter" value="${entry.key}"${state.filterHealth === entry.key ? " checked" : ""} />
      <span>${entry.label}</span>
    </label>`
  )).join("");

  filterEl.innerHTML = [
    '<div class="phren-hud-row">',
    `<input type="text" class="phren-hud-search" data-search-filter placeholder="Search the archive… (Enter flies to best hit)" value="${esc(state.searchQuery)}" />`,
    '<div data-filter-menu style="position:relative;flex:0 0 auto">',
    '<button class="phren-hud-btn" data-filter-toggle>Filters</button>',
    '<div class="phren-hud-panel" data-filter-panel>',
    '<div class="phren-hud-heading">Project</div>',
    `<select class="phren-hud-select" data-project-filter>
      <option value="all"${state.filterProject === "all" ? " selected" : ""}>All projects</option>
      ${projectNames.map((project) => `<option value="${esc(project)}"${state.filterProject === project ? " selected" : ""}>${esc(project)}</option>`).join("")}
    </select>`,
    storeNames.length > 1 ? '<div class="phren-hud-heading">Store</div>' : "",
    storeNames.length > 1 ? `<select class="phren-hud-select" data-store-filter>
      <option value="all"${state.filterStore === "all" ? " selected" : ""}>All stores</option>
      ${storeNames.map((store) => `<option value="${esc(store)}"${state.filterStore === store ? " selected" : ""}>${esc(store)}</option>`).join("")}
    </select>` : "",
    '<div class="phren-hud-heading">Type</div>',
    `<div class="phren-hud-grid">${typeSection}</div>`,
    topicSection ? '<div class="phren-hud-heading">Topics</div>' : "",
    topicSection ? `<div class="phren-hud-grid">${topicSection}</div>` : "",
    '<div class="phren-hud-heading">Health</div>',
    `<div class="phren-hud-grid">${healthSection}</div>`,
    '<div class="phren-hud-heading">Node limit</div>',
    `<input type="number" class="phren-hud-limit" data-limit-input min="50" max="50000" value="${state.nodeLimit}" />`,
    '</div>',
    '</div>',
    `<span class="phren-hud-counter" data-filter-counter>${state.visibleNodes.length} / ${state.rawNodes.length}</span>`,
    "</div>",
  ].join("");

  if (projectFilterEl) {
    projectFilterEl.style.display = "none";
    projectFilterEl.innerHTML = "";
  }
  if (limitRow) {
    limitRow.style.display = "none";
    limitRow.innerHTML = "";
  }

  const searchInput = filterEl.querySelector<HTMLInputElement>("[data-search-filter]");
  searchInput?.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    recomputeSearchMatches();
    applyHighlight();
    updateFilterBarCounter();
  });
  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const best = bestSearchMatch();
      if (best) selectNode(best.id);
      event.stopPropagation();
    } else if (event.key === "Escape") {
      searchInput.value = "";
      state.searchQuery = "";
      recomputeSearchMatches();
      applyHighlight();
      updateFilterBarCounter();
      searchInput.blur();
      event.stopPropagation();
    }
  });

  filterEl.querySelectorAll<HTMLInputElement>("[data-filter-type-check]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const key = checkbox.getAttribute("data-filter-type-check") as keyof typeof state.filterTypes;
      state.filterTypes[key] = checkbox.checked;
      applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
      syncLegendChips();
    });
  });

  filterEl.querySelectorAll<HTMLInputElement>("[data-filter-topic-check]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const slug = checkbox.getAttribute("data-filter-topic-check") || "";
      state.filterTopics[slug] = checkbox.checked;
      applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
      syncLegendChips();
    });
  });

  filterEl.querySelectorAll<HTMLInputElement>('input[name="graph-health-filter"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      state.filterHealth = radio.value;
      applyFilters({ resetCamera: false, emitSelection: Boolean(state.selectedNodeId) });
    });
  });

  const projectSelect = filterEl.querySelector<HTMLSelectElement>("[data-project-filter]");
  projectSelect?.addEventListener("change", () => {
    state.filterProject = projectSelect.value || "all";
    applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
  });

  const storeSelect = filterEl.querySelector<HTMLSelectElement>("[data-store-filter]");
  storeSelect?.addEventListener("change", () => {
    state.filterStore = storeSelect.value || "all";
    applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
  });

  const limitInput = filterEl.querySelector<HTMLInputElement>("[data-limit-input]");
  limitInput?.addEventListener("change", () => {
    const nextLimit = Number.parseInt(limitInput.value, 10);
    if (!Number.isFinite(nextLimit)) return;
    state.nodeLimit = clamp(nextLimit, 50, 50000);
    limitInput.value = String(state.nodeLimit);
    applyFilters({ resetCamera: false, emitSelection: Boolean(state.selectedNodeId) });
  });

  const filterToggle = filterEl.querySelector<HTMLElement>("[data-filter-toggle]");
  const filterPanel = filterEl.querySelector<HTMLElement>("[data-filter-panel]");
  if (filterToggle && filterPanel) {
    filterToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      filterPanel.style.display = filterPanel.style.display === "block" ? "none" : "block";
    });
    filterPanel.addEventListener("click", (event) => event.stopPropagation());
    const closePanel = () => { filterPanel.style.display = "none"; };
    document.addEventListener("click", closePanel);
    state.cleanupFns.push(() => document.removeEventListener("click", closePanel));
  }
}

export function updateFilterBarCounter(): void {
  const filterEl = document.getElementById("graph-filter");
  if (!filterEl) return;
  const counter = filterEl.querySelector<HTMLElement>("[data-filter-counter]");
  if (!counter) return;
  const visible = state.searchQuery.trim() ? state.searchMatchIds.size : state.visibleNodes.length;
  counter.textContent = `${visible} / ${state.rawNodes.length}`;
}

// ── Stats readout + legend chips (renderer-owned scene overlays) ────────

let statsEl: HTMLElement | null = null;
let legendEl: HTMLElement | null = null;

export function buildHudOverlays(): void {
  if (!state.container) return;
  injectHudCss();
  if (!statsEl || !statsEl.isConnected) {
    statsEl = document.createElement("div");
    statsEl.className = "phren-hud-stats";
    statsEl.setAttribute("aria-hidden", "true");
    state.container.appendChild(statsEl);
  }
  if (!legendEl || !legendEl.isConnected) {
    legendEl = document.createElement("div");
    legendEl.className = "phren-hud-legend";
    state.container.appendChild(legendEl);
  }
  renderLegend();
  updateHudStats();
}

function renderLegend(): void {
  if (!legendEl) return;
  const kindChips = [
    { key: "project", label: "Projects", color: KIND_COLORS.project },
    { key: "finding", label: "Findings", color: TOPIC_COLORS.general },
    { key: "task", label: "Tasks", color: KIND_COLORS["task-active"] },
    { key: "entity", label: "Fragments", color: KIND_COLORS.entity },
    { key: "reference", label: "Refs", color: KIND_COLORS.reference },
  ];
  // Kind chips only — the topic list can contain noisy auto-classified
  // slugs; those stay in the Filters panel where they're opt-in.
  legendEl.innerHTML = kindChips.map((chip) =>
    `<span class="phren-legend-chip${state.filterTypes[chip.key as keyof typeof state.filterTypes] ? "" : " off"}" data-legend-kind="${chip.key}">
      <span class="phren-hud-dot" style="background:${chip.color}"></span>${esc(chip.label)}
    </span>`).join("");

  legendEl.querySelectorAll<HTMLElement>("[data-legend-kind]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const key = chip.getAttribute("data-legend-kind") as keyof typeof state.filterTypes;
      state.filterTypes[key] = !state.filterTypes[key];
      syncPanelInputs();
      applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
      syncLegendChips();
    });
  });
  legendEl.querySelectorAll<HTMLElement>("[data-legend-topic]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const slug = chip.getAttribute("data-legend-topic") || "";
      state.filterTopics[slug] = state.filterTopics[slug] === false;
      syncPanelInputs();
      applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
      syncLegendChips();
    });
  });
}

function syncPanelInputs(): void {
  const filterEl = document.getElementById("graph-filter");
  if (!filterEl) return;
  filterEl.querySelectorAll<HTMLInputElement>("[data-filter-type-check]").forEach((checkbox) => {
    const key = checkbox.getAttribute("data-filter-type-check") as keyof typeof state.filterTypes;
    checkbox.checked = state.filterTypes[key];
  });
  filterEl.querySelectorAll<HTMLInputElement>("[data-filter-topic-check]").forEach((checkbox) => {
    const slug = checkbox.getAttribute("data-filter-topic-check") || "";
    checkbox.checked = state.filterTopics[slug] !== false;
  });
}

export function syncLegendChips(): void {
  if (!legendEl) return;
  legendEl.querySelectorAll<HTMLElement>("[data-legend-kind]").forEach((chip) => {
    const key = chip.getAttribute("data-legend-kind") as keyof typeof state.filterTypes;
    chip.classList.toggle("off", !state.filterTypes[key]);
  });
  legendEl.querySelectorAll<HTMLElement>("[data-legend-topic]").forEach((chip) => {
    const slug = chip.getAttribute("data-legend-topic") || "";
    chip.classList.toggle("off", state.filterTopics[slug] === false);
  });
}

/** "30 NODES · 40 LINKS · 5 PROJECTS" — deliberately slash-free so it can
 *  never shadow the filter-bar counter regex the e2e suite scans for. */
export function updateHudStats(): void {
  if (!statsEl) return;
  const projects = state.visibleNodes.reduce((count, node) => count + (node.kind === "project" ? 1 : 0), 0);
  statsEl.textContent = `${state.visibleNodes.length} NODES · ${state.visibleLinks.length} LINKS · ${projects} PROJECTS`;
}
