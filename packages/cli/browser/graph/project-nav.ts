import type { RuntimeNode } from "./types.js";
import { esc, state } from "./state.js";
import { clearSelection, selectNode } from "./interactions.js";
import { countAgingFindings, openReviewPane } from "./project-panel.js";

// Project navigator dock — a row of clickable project "orbs" pinned to the
// canvas (top-left). Clicking one selects/focuses that project directly, so a
// project can be reached without hunting for its tiny node amid the findings
// and tasks orbiting it. Built as a renderer-owned overlay (like the stats and
// legend readouts) so both the web-ui and the VS Code webview pick it up from
// the shared bundle with no host wiring.

const NAV_CSS = `
.phren-project-nav{
  position:absolute;left:16px;top:14px;z-index:8;
  display:flex;align-items:center;gap:7px;
  max-width:min(46%, calc(100% - 620px));min-width:0;
  padding:5px 7px;border-radius:999px;
  background:rgba(8,10,22,0.72);border:1px solid rgba(103,232,249,0.14);
  box-shadow:0 8px 26px rgba(0,0,0,0.45);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;
}
.phren-project-nav::-webkit-scrollbar{height:5px}
.phren-project-nav::-webkit-scrollbar-thumb{background:rgba(103,232,249,0.22);border-radius:999px}
.phren-project-nav[hidden]{display:none}
.phren-project-nav-tag{
  flex:0 0 auto;font:700 8.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#67e8f9;letter-spacing:0.14em;text-transform:uppercase;
  padding:0 4px 0 3px;opacity:0.7;user-select:none;
}
.phren-project-review{
  flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;cursor:pointer;
  padding:5px 11px;border-radius:999px;white-space:nowrap;user-select:none;
  background:rgba(255,182,72,0.12);border:1px solid rgba(255,182,72,0.35);
  font:700 10px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#ffd8a1;letter-spacing:0.04em;transition:border-color 0.15s ease,background 0.15s ease;
}
.phren-project-review:hover{border-color:rgba(255,182,72,0.7);background:rgba(255,182,72,0.2)}
.phren-project-nav-div{flex:0 0 auto;width:1px;height:18px;background:rgba(103,232,249,0.16)}
.phren-project-orb{
  flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;
  cursor:pointer;padding:5px 11px 5px 9px;border-radius:999px;
  background:rgba(12,15,30,0.7);border:1px solid rgba(103,232,249,0.14);
  font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#c3ccef;letter-spacing:0.02em;white-space:nowrap;user-select:none;
  transition:border-color 0.15s ease,background 0.15s ease,color 0.15s ease;
}
.phren-project-orb:hover{border-color:rgba(103,232,249,0.5);color:#eaf2ff;background:rgba(103,232,249,0.08)}
.phren-project-orb .phren-project-dot{
  width:10px;height:10px;border-radius:999px;flex:0 0 auto;
  box-shadow:0 0 8px 1px currentColor;
}
.phren-project-orb.active{
  border-color:rgba(255,209,102,0.7);color:#fff;
  background:rgba(255,209,102,0.12);
  box-shadow:0 0 0 1px rgba(255,209,102,0.25),0 0 16px rgba(255,209,102,0.14);
}
.phren-project-orb-count{
  font:600 9px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#7f8db3;font-variant-numeric:tabular-nums;
}
.phren-project-orb.active .phren-project-orb-count{color:#ffe1a3}
@media (prefers-reduced-motion: reduce){.phren-project-orb{transition:none}}
`;

function injectNavCss(): void {
  if (document.getElementById("phren-project-nav-css")) return;
  const style = document.createElement("style");
  style.id = "phren-project-nav-css";
  style.textContent = NAV_CSS;
  document.head.appendChild(style);
}

let navEl: HTMLElement | null = null;

/** findings/tasks count for a project — payload-sourced, adjacency fallback. */
function projectCounts(node: RuntimeNode): { findings: number; tasks: number } {
  const adjacency = state.fullAdjacency.get(node.id);
  const findings = typeof node.findingCount === "number"
    ? node.findingCount
    : adjacency
      ? [...adjacency].filter((id) => state.nodeById.get(id)?.kind === "finding").length
      : 0;
  const tasks = typeof node.taskCount === "number"
    ? node.taskCount
    : adjacency
      ? [...adjacency].filter((id) => state.nodeById.get(id)?.kind === "task").length
      : 0;
  return { findings, tasks };
}

/** The project nodes currently on screen, ordered by name for a stable dock. */
function visibleProjects(): RuntimeNode[] {
  return state.visibleNodes
    .filter((node) => node.kind === "project")
    .slice()
    .sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id));
}

/** (Re)build the dock from the visible project set. Idempotent per filter change. */
export function buildProjectNav(): void {
  if (!state.container) return;
  injectNavCss();
  if (!navEl || !navEl.isConnected) {
    navEl = document.createElement("nav");
    navEl.className = "phren-project-nav";
    navEl.setAttribute("aria-label", "Project navigator");
    // The dock lives INSIDE the force-graph container, so a bubbling pointer
    // sequence reaches ForceGraph's own listener, which synthesizes a
    // background click on empty space and clears the selection we just made.
    // Stop both pointerdown and click here so selecting an orb sticks.
    navEl.addEventListener("pointerdown", (event) => event.stopPropagation());
    navEl.addEventListener("click", (event) => {
      event.stopPropagation();
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-review-open]")) {
        openReviewPane();
        return;
      }
      const orb = target?.closest<HTMLElement>("[data-project-id]");
      if (!orb) return;
      const id = orb.getAttribute("data-project-id");
      if (id) selectNode(id);
    });
    state.container.appendChild(navEl);
  }

  const projects = visibleProjects();
  if (projects.length === 0) {
    navEl.setAttribute("hidden", "");
    navEl.innerHTML = "";
    return;
  }
  navEl.removeAttribute("hidden");

  const orbs = projects.map((node) => {
    const { findings, tasks } = projectCounts(node);
    const total = findings + tasks;
    const active = state.focusedProjectId === node.id ? " active" : "";
    const title = `${node.label} · ${findings} findings · ${tasks} tasks`;
    return (
      `<button type="button" class="phren-project-orb${active}" data-project-id="${esc(node.id)}" title="${esc(title)}">` +
      `<span class="phren-project-dot" style="background:${esc(node.baseColor)};color:${esc(node.baseColor)}"></span>` +
      `<span class="phren-project-orb-label">${esc(node.label)}</span>` +
      (total > 0 ? `<span class="phren-project-orb-count">${total}</span>` : "") +
      `</button>`
    );
  }).join("");

  // A leading "needs review" pill when any aging findings exist — one click to
  // the cross-project prune view.
  const aging = countAgingFindings();
  const reviewPill = aging > 0
    ? `<button type="button" class="phren-project-review" data-review-open title="Review ${aging} aging findings across all projects">⚠ ${aging}</button><span class="phren-project-nav-div"></span>`
    : "";

  navEl.innerHTML = `<span class="phren-project-nav-tag">◆</span>${reviewPill}${orbs}`;
}

/** Reflect the focused project in the dock without rebuilding the whole list. */
export function syncProjectNavActive(): void {
  if (!navEl) return;
  navEl.querySelectorAll<HTMLElement>("[data-project-id]").forEach((orb) => {
    const id = orb.getAttribute("data-project-id");
    const active = Boolean(id) && state.focusedProjectId === id;
    orb.classList.toggle("active", active);
    if (active) orb.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

/** Keyboard step through projects (←/→) — cycles focus, wrapping around. */
export function stepProject(delta: number): void {
  const projects = visibleProjects();
  if (projects.length === 0) return;
  const current = state.focusedProjectId
    ? projects.findIndex((node) => node.id === state.focusedProjectId)
    : -1;
  if (current < 0) {
    selectNode(projects[delta > 0 ? 0 : projects.length - 1].id);
    return;
  }
  const next = (current + delta + projects.length) % projects.length;
  if (projects[next].id === state.focusedProjectId) {
    clearSelection();
    return;
  }
  selectNode(projects[next].id);
}
