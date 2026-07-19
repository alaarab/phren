import type { RuntimeNode } from "./types.js";
import { clamp, esc, nodeDetail, state } from "./state.js";
import { clearSelection, selectNode } from "./interactions.js";

// Project contents pane — a right-docked, scrollable index of a project's
// findings and tasks. It appears whenever a project is "in context" (its orb
// is focused, or one of its own findings/tasks is selected) so you can scroll
// the whole list, filter it, and jump straight to any item instead of hunting
// for its node in 3D. Clicking a row flies to that node and opens the existing
// dossier (where Edit/Delete already live). Health-tinted rows plus the health
// filter make aging findings easy to surface and prune.
//
// Lives in the shared bundle (like the project navigator) so the web-ui and the
// VS Code webview both pick it up with no host wiring — selection is the only
// contract it needs, and the host reacts to that exactly as it does for a click.

const HEALTH_COLOR: Record<string, string> = {
  healthy: "#3ce8a4",
  decaying: "#ffb648",
  stale: "#ff5470",
};
const HEALTH_RANK: Record<string, number> = { stale: 2, decaying: 1, healthy: 0 };

const PANEL_CSS = `
.phren-project-panel{
  position:absolute;right:58px;top:64px;bottom:16px;z-index:9;
  width:min(340px, calc(100% - 420px));display:flex;flex-direction:column;
  border:1px solid rgba(103,232,249,0.22);border-radius:12px;
  background:rgba(8,10,22,0.92);color:#dbe4ff;
  box-shadow:0 16px 60px rgba(0,0,0,0.6),0 0 30px rgba(103,232,249,0.05);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);overflow:hidden;
}
.phren-project-panel[hidden]{display:none}
.phren-pp-head{
  display:flex;align-items:flex-start;gap:8px;padding:13px 14px 10px;
  border-bottom:1px solid rgba(103,232,249,0.12);
}
.phren-pp-title{flex:1 1 auto;min-width:0}
.phren-pp-kind{
  font:700 9.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#67e8f9;letter-spacing:0.14em;text-transform:uppercase;
}
.phren-pp-name{
  font:600 14px/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#eaf2ff;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.phren-pp-sub{
  font:600 10px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#8b96c9;letter-spacing:0.04em;margin-top:4px;
}
.phren-pp-health{display:flex;height:6px;border-radius:999px;overflow:hidden;margin-top:9px;background:rgba(255,255,255,0.06)}
.phren-pp-health span{display:block;height:100%}
.phren-pp-healthkey{display:flex;flex-wrap:wrap;gap:10px;margin-top:7px}
.phren-pp-healthkey button{
  display:inline-flex;align-items:center;gap:5px;cursor:pointer;background:none;border:none;padding:0;
  font:600 9px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#8b96c9;letter-spacing:0.05em;
}
.phren-pp-healthkey button:hover{color:#eaf2ff}
.phren-pp-healthkey i{width:7px;height:7px;border-radius:999px;font-style:normal}
.phren-pp-close{
  flex:0 0 auto;width:26px;height:26px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(103,232,249,0.2);background:rgba(12,15,30,0.9);
  color:#c3ccef;font-size:15px;line-height:1;display:grid;place-items:center;
}
.phren-pp-close:hover{border-color:rgba(103,232,249,0.55);color:#eaf2ff}
.phren-pp-controls{padding:10px 14px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid rgba(103,232,249,0.1)}
.phren-pp-search{
  width:100%;padding:8px 11px;border-radius:8px;
  background:rgba(12,15,30,0.9);color:#dbe4ff;border:1px solid rgba(103,232,249,0.18);
  font:500 12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:0.02em;outline:none;
}
.phren-pp-search:focus{border-color:rgba(103,232,249,0.5)}
.phren-pp-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.phren-pp-sort{
  margin-left:auto;padding:4px 8px;border-radius:7px;cursor:pointer;
  background:rgba(12,15,30,0.9);color:#c3ccef;border:1px solid rgba(103,232,249,0.18);
  font:600 9.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.04em;
}
.phren-pp-sort:focus{outline:none;border-color:rgba(103,232,249,0.5)}
.phren-pp-chip{
  cursor:pointer;padding:4px 9px;border-radius:999px;user-select:none;
  border:1px solid rgba(103,232,249,0.16);background:rgba(12,15,30,0.7);
  font:600 9.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#aeb7dd;letter-spacing:0.05em;text-transform:uppercase;
  transition:border-color 0.15s ease,color 0.15s ease,background 0.15s ease;
}
.phren-pp-chip:hover{border-color:rgba(103,232,249,0.45);color:#eaf2ff}
.phren-pp-chip.on{border-color:rgba(103,232,249,0.6);color:#eaf6ff;background:rgba(103,232,249,0.12)}
.phren-pp-chip.on[data-health="aging"]{border-color:rgba(255,182,72,0.6);color:#ffe1a3;background:rgba(255,182,72,0.12)}
.phren-pp-list{flex:1 1 auto;overflow-y:auto;padding:6px;scrollbar-width:thin}
.phren-pp-list::-webkit-scrollbar{width:6px}
.phren-pp-list::-webkit-scrollbar-thumb{background:rgba(103,232,249,0.22);border-radius:999px}
.phren-pp-group{
  font:700 9px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#67e8f9;letter-spacing:0.14em;text-transform:uppercase;
  padding:9px 8px 5px;position:sticky;top:0;background:rgba(8,10,22,0.92);
}
.phren-pp-row{
  display:flex;align-items:center;gap:9px;width:100%;text-align:left;cursor:pointer;
  background:transparent;border:1px solid transparent;border-left:2px solid transparent;
  border-radius:7px;padding:7px 9px;margin-bottom:2px;color:#c9d2f2;
  font:500 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.phren-pp-row:hover{background:rgba(103,232,249,0.06);border-color:rgba(103,232,249,0.16)}
.phren-pp-row.active{background:rgba(255,209,102,0.12);border-color:rgba(255,209,102,0.55);color:#fff}
.phren-pp-row.cursor{border-color:rgba(103,232,249,0.7);box-shadow:0 0 0 1px rgba(103,232,249,0.28) inset}
.phren-pp-dot{width:8px;height:8px;border-radius:999px;flex:0 0 auto;box-shadow:0 0 7px 1px currentColor}
.phren-pp-rowlabel{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.phren-pp-rowchip{
  flex:0 0 auto;font:600 8.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  text-transform:uppercase;letter-spacing:0.05em;color:#8b96c9;
  background:rgba(12,15,30,0.9);border:1px solid rgba(103,232,249,0.14);
  border-radius:999px;padding:2px 7px;max-width:38%;overflow:hidden;text-overflow:ellipsis;
}
.phren-pp-del{
  flex:0 0 auto;width:22px;height:22px;padding:0;border-radius:6px;cursor:pointer;
  border:1px solid rgba(255,84,112,0.3);background:rgba(255,84,112,0.08);
  color:#ff7b93;font-size:12px;line-height:1;display:none;place-items:center;
}
.phren-pp-row:hover .phren-pp-del,.phren-pp-row.active .phren-pp-del{display:grid}
.phren-pp-del:hover{border-color:rgba(255,84,112,0.7);background:rgba(255,84,112,0.18);color:#ffb3c1}
.phren-pp-empty{padding:22px 12px;text-align:center;color:#5b6488;
  font:600 10px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.06em}
@media (max-width: 900px){.phren-project-panel{width:min(300px, calc(100% - 32px))}}
`;

function injectPanelCss(): void {
  if (document.getElementById("phren-project-panel-css")) return;
  const style = document.createElement("style");
  style.id = "phren-project-panel-css";
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

let panelEl: HTMLElement | null = null;
let renderedProjectId: string | null = null;
let cursorId: string | null = null;
const filters = {
  query: "",
  kind: "all" as "all" | "finding" | "task",
  health: "all" as "all" | "aging" | "healthy" | "decaying" | "stale",
  sort: "aging" as "aging" | "recent" | "az",
};

/** Comparator for the current sort mode (applied within each group). */
function sortComparator(a: RuntimeNode, b: RuntimeNode): number {
  if (filters.sort === "az") return (a.label || "").localeCompare(b.label || "");
  if (filters.sort === "recent") {
    const da = a.date ? Date.parse(a.date) : 0;
    const db = b.date ? Date.parse(b.date) : 0;
    return (db || 0) - (da || 0);
  }
  // aging: worst health first, so prunable items lead the list.
  return HEALTH_RANK[b.health] - HEALTH_RANK[a.health];
}

/** Hide the bottom-right legend while the pane occupies that corner. */
function setLegendHidden(hidden: boolean): void {
  const legend = state.container?.querySelector<HTMLElement>(".phren-hud-legend");
  if (legend) legend.style.display = hidden ? "none" : "";
}

function projectNodeByName(name: string): RuntimeNode | undefined {
  return state.rawNodes.find((node) => node.kind === "project" && (node.project || node.id) === name);
}

/** The project node id whose contents the pane should show, or null to hide. */
function contextProjectId(): string | null {
  if (state.focusedProjectId) return state.focusedProjectId;
  if (state.selectedNodeId) {
    const node = state.nodeById.get(state.selectedNodeId);
    if (node) {
      if (node.kind === "project") return node.id;
      if (node.project) {
        const project = projectNodeByName(node.project);
        if (project) return project.id;
      }
    }
  }
  return null;
}

/** All findings + tasks belonging to a project (payload order preserved). */
function projectItems(projectName: string): RuntimeNode[] {
  return state.rawNodes.filter(
    (node) => (node.kind === "finding" || node.kind === "task") && node.project === projectName,
  );
}

function matchesFilters(node: RuntimeNode): boolean {
  if (filters.kind !== "all" && node.kind !== filters.kind) return false;
  if (filters.health !== "all") {
    // Health is a finding property, so any health filter implies findings only.
    if (node.kind !== "finding") return false;
    if (filters.health === "aging" ? node.health === "healthy" : node.health !== filters.health) return false;
  }
  const q = filters.query.trim().toLowerCase();
  if (q && !node.searchText.includes(q)) return false;
  return true;
}

function rowHtml(node: RuntimeNode): string {
  const active = state.selectedNodeId === node.id ? " active" : "";
  const dotColor = node.kind === "task" ? node.baseColor : HEALTH_COLOR[node.health] || "#8b96c9";
  const label = node.fullLabel || node.label || node.id;
  const chip = node.kind === "task"
    ? (node.section || "task")
    : (node.topicLabel || node.topicSlug || node.health);
  // The delete affordance only appears when a host has registered a handler
  // (web-ui does; a host without one simply never shows a dead button).
  const del = state.itemActionCallbacks.length
    ? `<span class="phren-pp-del" data-pp-del title="Delete this ${esc(node.kind)}">🗑</span>`
    : "";
  return (
    `<button type="button" class="phren-pp-row${active}" data-node-id="${esc(node.id)}" title="${esc(label)}">` +
    `<span class="phren-pp-dot" style="background:${esc(dotColor)};color:${esc(dotColor)}"></span>` +
    `<span class="phren-pp-rowlabel">${esc(label)}</span>` +
    `<span class="phren-pp-rowchip">${esc(chip)}</span>` +
    del +
    `</button>`
  );
}

function renderList(): void {
  if (!panelEl || !renderedProjectId) return;
  const listEl = panelEl.querySelector<HTMLElement>("[data-pp-list]");
  if (!listEl) return;
  const project = state.nodeById.get(renderedProjectId);
  const projectName = project ? project.project || project.id : "";
  const items = projectItems(projectName).filter(matchesFilters);
  // Findings, then tasks; each group ordered by the active sort mode.
  const findings = items.filter((n) => n.kind === "finding").sort(sortComparator);
  const tasks = items.filter((n) => n.kind === "task").sort(sortComparator);

  if (!findings.length && !tasks.length) {
    listEl.innerHTML = `<div class="phren-pp-empty">No matching items</div>`;
    cursorId = null;
    return;
  }
  let html = "";
  if (findings.length) {
    html += `<div class="phren-pp-group">Findings · ${findings.length}</div>`;
    html += findings.map(rowHtml).join("");
  }
  if (tasks.length) {
    html += `<div class="phren-pp-group">Tasks · ${tasks.length}</div>`;
    html += tasks.map(rowHtml).join("");
  }
  listEl.innerHTML = html;
  // Drop the cursor if its row was filtered out; otherwise repaint it.
  if (cursorId && !rowIdsInOrder().includes(cursorId)) cursorId = null;
  paintCursor();
}

function buildPanel(projectId: string): void {
  if (!state.container) return;
  injectPanelCss();
  if (!panelEl || !panelEl.isConnected) {
    panelEl = document.createElement("aside");
    panelEl.className = "phren-project-panel";
    panelEl.setAttribute("aria-label", "Project contents");
    // Inside the force-graph container: stop the pointer sequence so ForceGraph
    // doesn't read it as a background click and clear the selection.
    panelEl.addEventListener("pointerdown", (event) => event.stopPropagation());
    panelEl.addEventListener("click", (event) => {
      event.stopPropagation();
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-pp-close]")) {
        clearSelection();
        return;
      }
      const chip = target?.closest<HTMLElement>("[data-pp-chip]");
      if (chip) {
        applyChip(chip);
        return;
      }
      const healthKey = target?.closest<HTMLElement>("[data-pp-health-key]");
      if (healthKey) {
        const mode = healthKey.getAttribute("data-pp-health-key") as typeof filters.health;
        filters.health = filters.health === mode ? "all" : mode;
        filters.kind = "all";
        if (renderedProjectId) buildPanel(renderedProjectId); // reflect all control states
        return;
      }
      const row = target?.closest<HTMLElement>("[data-node-id]");
      if (!row) return;
      const id = row.getAttribute("data-node-id");
      if (!id) return;
      if (target?.closest("[data-pp-del]")) {
        const detail = nodeDetail(id);
        if (detail) state.itemActionCallbacks.forEach((cb) => cb(detail, "delete"));
        return;
      }
      cursorId = id;
      selectNode(id);
    });
    // Keyboard review: ↑/↓ move a cursor row, Enter flies to it, Delete prunes.
    // Works whenever focus is inside the pane (its filter input or a row button).
    panelEl.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") { moveCursor(1); event.preventDefault(); }
      else if (event.key === "ArrowUp") { moveCursor(-1); event.preventDefault(); }
      else if (event.key === "Enter" && cursorId) { selectNode(cursorId); event.preventDefault(); }
      else if (event.key === "Delete" && cursorId && state.itemActionCallbacks.length) {
        const detail = nodeDetail(cursorId);
        if (detail) state.itemActionCallbacks.forEach((cb) => cb(detail, "delete"));
        event.preventDefault();
      }
    });
    state.container.appendChild(panelEl);
  }

  const project = state.nodeById.get(projectId);
  const projectName = project ? project.label || project.project || project.id : "";
  const all = project ? projectItems(project.project || project.id) : [];
  const findingItems = all.filter((n) => n.kind === "finding");
  const findingCount = findingItems.length;
  const taskCount = all.length - findingCount;

  // Memory-health tally across the project's findings — a stacked bar plus a
  // clickable key so aging memory is visible (and filterable) at a glance.
  const health = { healthy: 0, decaying: 0, stale: 0 };
  for (const f of findingItems) health[f.health]++;
  const total = findingCount || 1;
  const seg = (n: number, color: string) => (n ? `<span style="width:${(n / total) * 100}%;background:${color}"></span>` : "");
  const healthBar = findingCount
    ? `<div class="phren-pp-health" title="${health.healthy} healthy · ${health.decaying} decaying · ${health.stale} stale">`
      + seg(health.healthy, HEALTH_COLOR.healthy) + seg(health.decaying, HEALTH_COLOR.decaying) + seg(health.stale, HEALTH_COLOR.stale)
      + "</div>"
      + '<div class="phren-pp-healthkey">'
      + `<button type="button" data-pp-health-key="healthy"><i style="background:${HEALTH_COLOR.healthy}"></i>${health.healthy} healthy</button>`
      + `<button type="button" data-pp-health-key="decaying"><i style="background:${HEALTH_COLOR.decaying}"></i>${health.decaying} decaying</button>`
      + `<button type="button" data-pp-health-key="stale"><i style="background:${HEALTH_COLOR.stale}"></i>${health.stale} stale</button>`
      + "</div>"
    : "";

  panelEl.innerHTML = [
    '<div class="phren-pp-head">',
    '<div class="phren-pp-title">',
    '<div class="phren-pp-kind">Project</div>',
    `<div class="phren-pp-name" title="${esc(projectName)}">${esc(projectName)}</div>`,
    `<div class="phren-pp-sub">${findingCount} findings · ${taskCount} tasks</div>`,
    healthBar,
    "</div>",
    '<button type="button" class="phren-pp-close" data-pp-close aria-label="Close">×</button>',
    "</div>",
    '<div class="phren-pp-controls">',
    `<input type="text" class="phren-pp-search" data-pp-search placeholder="Filter in project…" value="${esc(filters.query)}" />`,
    '<div class="phren-pp-chips">',
    `<span class="phren-pp-chip${filters.kind === "all" ? " on" : ""}" data-pp-chip data-kind="all">All</span>`,
    `<span class="phren-pp-chip${filters.kind === "finding" ? " on" : ""}" data-pp-chip data-kind="finding">Findings</span>`,
    `<span class="phren-pp-chip${filters.kind === "task" ? " on" : ""}" data-pp-chip data-kind="task">Tasks</span>`,
    `<span class="phren-pp-chip${filters.health === "aging" ? " on" : ""}" data-pp-chip data-health="aging" title="Show only decaying or stale">⚠ Aging</span>`,
    `<select class="phren-pp-sort" data-pp-sort aria-label="Sort items" title="Sort">`,
    `<option value="aging"${filters.sort === "aging" ? " selected" : ""}>Aging first</option>`,
    `<option value="recent"${filters.sort === "recent" ? " selected" : ""}>Recent</option>`,
    `<option value="az"${filters.sort === "az" ? " selected" : ""}>A–Z</option>`,
    "</select>",
    "</div>",
    "</div>",
    '<div class="phren-pp-list" data-pp-list></div>',
  ].join("");

  const searchInput = panelEl.querySelector<HTMLInputElement>("[data-pp-search]");
  searchInput?.addEventListener("input", () => {
    filters.query = searchInput.value;
    renderList();
  });

  const sortSelect = panelEl.querySelector<HTMLSelectElement>("[data-pp-sort]");
  sortSelect?.addEventListener("change", () => {
    filters.sort = (sortSelect.value as typeof filters.sort) || "aging";
    renderList();
  });

  renderedProjectId = projectId;
  renderList();
  syncActiveRow();
}

function applyChip(chip: HTMLElement): void {
  const health = chip.getAttribute("data-health");
  if (health === "aging") {
    filters.health = filters.health === "aging" ? "all" : "aging";
  } else {
    const kind = chip.getAttribute("data-kind") as "all" | "finding" | "task" | null;
    if (kind) filters.kind = kind;
  }
  // Reflect chip state without a full rebuild.
  panelEl?.querySelectorAll<HTMLElement>("[data-pp-chip]").forEach((el) => {
    const elHealth = el.getAttribute("data-health");
    const on = elHealth === "aging" ? filters.health === "aging" : el.getAttribute("data-kind") === filters.kind;
    el.classList.toggle("on", on);
  });
  renderList();
}

/** Node ids of the rows currently rendered, in display order. */
function rowIdsInOrder(): string[] {
  if (!panelEl) return [];
  return Array.from(panelEl.querySelectorAll<HTMLElement>("[data-node-id]"))
    .map((row) => row.getAttribute("data-node-id"))
    .filter((id): id is string => Boolean(id));
}

/** Paint the cursor row and scroll it into view. */
function paintCursor(): void {
  if (!panelEl) return;
  panelEl.querySelectorAll<HTMLElement>("[data-node-id]").forEach((row) => {
    const on = row.getAttribute("data-node-id") === cursorId;
    row.classList.toggle("cursor", on);
    if (on) row.scrollIntoView({ block: "nearest" });
  });
}

/** Move the keyboard cursor by delta through the visible rows. */
function moveCursor(delta: number): void {
  const ids = rowIdsInOrder();
  if (!ids.length) return;
  const idx = cursorId ? ids.indexOf(cursorId) : -1;
  const next = idx < 0 ? (delta > 0 ? 0 : ids.length - 1) : clamp(idx + delta, 0, ids.length - 1);
  cursorId = ids[next];
  paintCursor();
}

/** Highlight the row for the current selection and scroll it into view. */
function syncActiveRow(): void {
  if (!panelEl) return;
  let active: HTMLElement | null = null;
  panelEl.querySelectorAll<HTMLElement>("[data-node-id]").forEach((row) => {
    const on = row.getAttribute("data-node-id") === state.selectedNodeId;
    row.classList.toggle("active", on);
    if (on) active = row;
  });
  (active as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
}

/**
 * Recompute context and reconcile the pane: hide when no project is in context,
 * fully (re)build when the context project changes, else just move the active
 * row highlight. Cheap enough to call on every selection / filter change.
 */
export function refreshProjectPanel(opts?: { data?: boolean }): void {
  if (!state.container) return;
  const ctx = contextProjectId();
  if (!ctx) {
    if (panelEl) {
      panelEl.setAttribute("hidden", "");
      panelEl.innerHTML = "";
    }
    renderedProjectId = null;
    setLegendHidden(false);
    return;
  }
  setLegendHidden(true);
  if (ctx !== renderedProjectId || !panelEl || !panelEl.isConnected) {
    buildPanel(ctx);
    panelEl?.removeAttribute("hidden");
    return;
  }
  panelEl.removeAttribute("hidden");
  // If a selected item of this project is being hidden by the kind/health
  // filters, relax them so the selection is never invisible in its own pane
  // (a query the user typed is left intact — that's explicit intent).
  const sel = state.selectedNodeId;
  if (sel && (filters.kind !== "all" || filters.health !== "all")) {
    const node = state.nodeById.get(sel);
    if (node && (node.kind === "finding" || node.kind === "task") && !matchesFilters(node)) {
      filters.kind = "all";
      filters.health = "all";
      buildPanel(ctx);
      return;
    }
  }
  // A data change (filter, delete, external refresh) can add/drop rows, so the
  // list is re-rendered; a plain selection change only moves the highlight.
  if (opts?.data) renderList();
  syncActiveRow();
}
