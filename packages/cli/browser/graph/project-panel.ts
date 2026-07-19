import type { RuntimeNode } from "./types.js";
import { esc, state } from "./state.js";
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
.phren-pp-chips{display:flex;flex-wrap:wrap;gap:6px}
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
.phren-pp-dot{width:8px;height:8px;border-radius:999px;flex:0 0 auto;box-shadow:0 0 7px 1px currentColor}
.phren-pp-rowlabel{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.phren-pp-rowchip{
  flex:0 0 auto;font:600 8.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  text-transform:uppercase;letter-spacing:0.05em;color:#8b96c9;
  background:rgba(12,15,30,0.9);border:1px solid rgba(103,232,249,0.14);
  border-radius:999px;padding:2px 7px;max-width:38%;overflow:hidden;text-overflow:ellipsis;
}
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
const filters = { query: "", kind: "all" as "all" | "finding" | "task", health: false };

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
  if (filters.health && node.health === "healthy") return false;
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
  return (
    `<button type="button" class="phren-pp-row${active}" data-node-id="${esc(node.id)}" title="${esc(label)}">` +
    `<span class="phren-pp-dot" style="background:${esc(dotColor)};color:${esc(dotColor)}"></span>` +
    `<span class="phren-pp-rowlabel">${esc(label)}</span>` +
    `<span class="phren-pp-rowchip">${esc(chip)}</span>` +
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
  // Findings, then tasks; within each, aging (stale→decaying→healthy) first so
  // the rows most worth pruning float to the top of their group.
  const findings = items.filter((n) => n.kind === "finding").sort((a, b) => HEALTH_RANK[b.health] - HEALTH_RANK[a.health]);
  const tasks = items.filter((n) => n.kind === "task");

  if (!findings.length && !tasks.length) {
    listEl.innerHTML = `<div class="phren-pp-empty">No matching items</div>`;
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
      const row = target?.closest<HTMLElement>("[data-node-id]");
      if (row) {
        const id = row.getAttribute("data-node-id");
        if (id) selectNode(id);
      }
    });
    state.container.appendChild(panelEl);
  }

  const project = state.nodeById.get(projectId);
  const projectName = project ? project.label || project.project || project.id : "";
  const all = project ? projectItems(project.project || project.id) : [];
  const findingCount = all.filter((n) => n.kind === "finding").length;
  const taskCount = all.filter((n) => n.kind === "task").length;

  panelEl.innerHTML = [
    '<div class="phren-pp-head">',
    '<div class="phren-pp-title">',
    '<div class="phren-pp-kind">Project</div>',
    `<div class="phren-pp-name" title="${esc(projectName)}">${esc(projectName)}</div>`,
    `<div class="phren-pp-sub">${findingCount} findings · ${taskCount} tasks</div>`,
    "</div>",
    '<button type="button" class="phren-pp-close" data-pp-close aria-label="Close">×</button>',
    "</div>",
    '<div class="phren-pp-controls">',
    `<input type="text" class="phren-pp-search" data-pp-search placeholder="Filter in project…" value="${esc(filters.query)}" />`,
    '<div class="phren-pp-chips">',
    `<span class="phren-pp-chip${filters.kind === "all" ? " on" : ""}" data-pp-chip data-kind="all">All</span>`,
    `<span class="phren-pp-chip${filters.kind === "finding" ? " on" : ""}" data-pp-chip data-kind="finding">Findings</span>`,
    `<span class="phren-pp-chip${filters.kind === "task" ? " on" : ""}" data-pp-chip data-kind="task">Tasks</span>`,
    `<span class="phren-pp-chip${filters.health ? " on" : ""}" data-pp-chip data-health="aging" title="Show only decaying or stale">⚠ Aging</span>`,
    "</div>",
    "</div>",
    '<div class="phren-pp-list" data-pp-list></div>',
  ].join("");

  const searchInput = panelEl.querySelector<HTMLInputElement>("[data-pp-search]");
  searchInput?.addEventListener("input", () => {
    filters.query = searchInput.value;
    renderList();
  });

  renderedProjectId = projectId;
  renderList();
  syncActiveRow();
}

function applyChip(chip: HTMLElement): void {
  const health = chip.getAttribute("data-health");
  if (health === "aging") {
    filters.health = !filters.health;
  } else {
    const kind = chip.getAttribute("data-kind") as "all" | "finding" | "task" | null;
    if (kind) filters.kind = kind;
  }
  // Reflect chip state without a full rebuild.
  panelEl?.querySelectorAll<HTMLElement>("[data-pp-chip]").forEach((el) => {
    const elHealth = el.getAttribute("data-health");
    const on = elHealth === "aging" ? filters.health : el.getAttribute("data-kind") === filters.kind;
    el.classList.toggle("on", on);
  });
  renderList();
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
  // A data change (filter, delete, external refresh) can add/drop rows, so the
  // list is re-rendered; a plain selection change only moves the highlight.
  if (opts?.data) renderList();
  syncActiveRow();
}
