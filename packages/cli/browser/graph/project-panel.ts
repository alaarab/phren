import type { NodeDetail, RuntimeNode } from "./types.js";
import { clamp, esc, nodeDetail, state } from "./state.js";
import { clearSelection, peekNode, selectNode } from "./interactions.js";

// Project contents pane — a right-docked, scrollable index of a project's
// findings and tasks. It appears whenever a project is "in context" (its orb
// is focused, or one of its own findings/tasks is selected) so you can scroll
// the whole list, filter it, and jump straight to any item instead of hunting
// for its node in 3D. Rows expand for reading and editing in place, while
// health-tinted rows plus the health filter make aging findings easy to prune.
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
  position:absolute;right:58px;left:auto;top:64px;z-index:9;
  width:min(300px, calc(100% - 32px));height:min(520px, calc(100% - 92px));display:flex;flex-direction:column;
  border:1px solid rgba(103,232,249,0.22);border-radius:12px;
  background:rgba(8,10,22,0.92);color:#dbe4ff;
  box-shadow:0 16px 60px rgba(0,0,0,0.6),0 0 30px rgba(103,232,249,0.05);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);overflow:hidden;
  animation:phren-pp-enter 180ms ease-out both;
  transition:left 180ms ease-out,top 180ms ease-out;
}
.phren-vscode-webview .phren-project-panel{left:16px;right:auto}
@keyframes phren-pp-enter{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:translateX(0)}}
.phren-project-panel[hidden]{display:none}
.phren-pp-head{
  display:flex;align-items:flex-start;gap:8px;padding:13px 14px 10px;
  border-bottom:1px solid rgba(103,232,249,0.12);
}
.phren-vscode-webview .phren-pp-head{cursor:move;touch-action:none}
.phren-vscode-webview .phren-pp-head button{cursor:pointer}
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
.phren-pp-healthkey button.active{color:#eafcff;text-decoration:underline;text-decoration-color:#67e8f9;text-underline-offset:3px}
.phren-pp-healthkey i{width:7px;height:7px;border-radius:999px;font-style:normal}
.phren-pp-headbtns{flex:0 0 auto;display:flex;gap:6px}
.phren-pp-iconbtn{
  width:26px;height:26px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(103,232,249,0.2);background:rgba(12,15,30,0.9);
  color:#c3ccef;font-size:14px;line-height:1;display:grid;place-items:center;padding:0;
}
.phren-pp-iconbtn:hover{border-color:rgba(103,232,249,0.55);color:#eaf2ff}
/* Slim tab shown when the pane is collapsed — click to reopen. */
.phren-pp-reopen{
  position:absolute;right:0;top:50%;transform:translateY(-50%);z-index:9;cursor:pointer;
  display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 7px;
  border:1px solid rgba(103,232,249,0.22);border-right:none;border-radius:10px 0 0 10px;
  background:rgba(8,10,22,0.9);color:#c3ccef;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  box-shadow:-6px 0 24px rgba(0,0,0,0.4);
}
.phren-pp-reopen:hover{border-color:rgba(103,232,249,0.5);color:#eaf2ff}
.phren-pp-reopen[hidden]{display:none}
.phren-pp-reopen-label{
  writing-mode:vertical-rl;font:700 9.5px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:0.14em;text-transform:uppercase;max-height:180px;overflow:hidden;text-overflow:ellipsis;
}
/* Independent edge handles: width and height never resize each other. */
.phren-pp-resize{position:absolute;left:-4px;right:auto;top:0;bottom:0;width:9px;cursor:ew-resize;z-index:3;touch-action:none}
.phren-vscode-webview .phren-pp-resize{left:auto;right:-4px}
.phren-pp-resize::after{
  content:"";position:absolute;left:3px;top:50%;transform:translateY(-50%);
  width:3px;height:38px;border-radius:999px;background:rgba(103,232,249,0.28);
  opacity:0;transition:opacity 0.15s ease;
}
.phren-vscode-webview .phren-pp-resize::after{left:auto;right:3px}
.phren-pp-resize:hover::after,.phren-pp-resize.dragging::after{opacity:1}
.phren-pp-resize-y{position:absolute;left:0;right:0;bottom:-4px;height:9px;cursor:ns-resize;z-index:4;touch-action:none}
.phren-pp-resize-y::after{
  content:"";position:absolute;left:50%;bottom:3px;transform:translateX(-50%);
  width:38px;height:3px;border-radius:999px;background:rgba(103,232,249,0.2);
  opacity:0;transition:opacity 0.15s ease;
}
.phren-pp-resize-y:hover::after,.phren-pp-resize-y.dragging::after{opacity:1}
.phren-pp-resize-xy{
  position:absolute;left:-3px;right:auto;bottom:-3px;width:15px;height:15px;z-index:5;
  cursor:nesw-resize;touch-action:none;border-radius:4px 0 0 0;
}
.phren-vscode-webview .phren-pp-resize-xy{left:auto;right:-3px;cursor:nwse-resize;border-radius:4px 0 0 0}
.phren-pp-resize-xy::after{
  content:"";position:absolute;inset:4px;border-right:2px solid rgba(103,232,249,0.3);border-bottom:2px solid rgba(103,232,249,0.3);
}
.phren-pp-resize-xy:hover::after,.phren-pp-resize-xy.dragging::after{border-color:rgba(103,232,249,0.72)}
.phren-pp-controls{padding:10px 14px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid rgba(103,232,249,0.1)}
.phren-pp-search{
  width:100%;padding:8px 11px;border-radius:8px;
  background:rgba(12,15,30,0.9);color:#dbe4ff;border:1px solid rgba(103,232,249,0.18);
  font:500 12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:0.02em;outline:none;
}
.phren-pp-search:focus{border-color:rgba(103,232,249,0.5)}
.phren-pp-chips,.phren-pp-tools{display:flex;flex-wrap:wrap;align-items:center;gap:7px}
.phren-pp-tools{padding-top:1px}
.phren-pp-sort{
  margin-left:auto;min-width:112px;padding:6px 9px;border-radius:7px;cursor:pointer;
  background:rgba(12,15,30,0.9);color:#c3ccef;border:1px solid rgba(103,232,249,0.18);
  font:600 9.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.04em;
}
.phren-pp-sort:focus{outline:none;border-color:rgba(103,232,249,0.5)}
.phren-pp-chip{
  cursor:pointer;padding:5px 10px;border-radius:999px;user-select:none;
  border:1px solid rgba(103,232,249,0.16);background:rgba(12,15,30,0.7);
  font:600 9.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#aeb7dd;letter-spacing:0.05em;text-transform:uppercase;
  transition:border-color 0.15s ease,color 0.15s ease,background 0.15s ease;
}
.phren-pp-chip:hover{border-color:rgba(103,232,249,0.45);color:#eaf2ff}
.phren-pp-chip.on{border-color:#67e8f9;color:#eafcff;background:rgba(103,232,249,0.16);box-shadow:0 0 0 1px rgba(103,232,249,0.12) inset}
.phren-pp-chip.on::before{content:"✓";margin-right:5px;color:#67e8f9}
.phren-pp-chip.on[data-health="aging"]{border-color:#ffb648;color:#ffe1a3;background:rgba(255,182,72,0.14)}
.phren-pp-chip.on[data-health="aging"]::before{color:#ffb648}
.phren-pp-list{flex:1 1 auto;overflow-y:auto;padding:6px;scrollbar-width:thin;scrollbar-color:rgba(139,150,201,0.16) transparent}
.phren-pp-list::-webkit-scrollbar{width:4px}
.phren-pp-list::-webkit-scrollbar-track{background:transparent}
.phren-pp-list::-webkit-scrollbar-thumb{background:rgba(139,150,201,0.14);border-radius:999px}
.phren-pp-list:hover::-webkit-scrollbar-thumb{background:rgba(139,150,201,0.28)}
.phren-pp-group{
  display:flex;align-items:center;gap:7px;
  font:700 9px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#67e8f9;text-transform:uppercase;
  padding:9px 8px 6px;margin:0 2px 4px;position:sticky;top:0;z-index:1;
  background:rgba(8,10,22,0.96);border-bottom:1px solid rgba(103,232,249,0.1);
}
.phren-pp-group-label{letter-spacing:0.12em}
.phren-pp-group-count{color:#8b96c9;letter-spacing:0.04em;font-variant-numeric:tabular-nums}
.phren-pp-row{
  display:flex;align-items:flex-start;gap:9px;width:100%;text-align:left;cursor:pointer;
  background:transparent;border:1px solid transparent;border-left:2px solid transparent;
  border-radius:7px;padding:7px 9px;margin-bottom:2px;color:#c9d2f2;
  font:500 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.phren-pp-row:hover{background:rgba(103,232,249,0.06);border-color:rgba(103,232,249,0.16)}
.phren-pp-row.active{background:rgba(103,232,249,0.1);border-color:rgba(103,232,249,0.62);color:#fff;box-shadow:inset 3px 0 #67e8f9}
.phren-pp-row.active{flex-wrap:wrap}
.phren-pp-row.cursor{border-color:rgba(103,232,249,0.7);box-shadow:0 0 0 1px rgba(103,232,249,0.28) inset}
.phren-pp-dot{width:8px;height:8px;border-radius:999px;flex:0 0 auto;box-shadow:0 0 7px 1px currentColor;margin-top:4px}
.phren-pp-rowlabel{flex:1 1 auto;min-width:0;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:1.4}
.phren-pp-row.active .phren-pp-rowlabel{-webkit-line-clamp:2}
.phren-pp-rowdetail{
  display:none;flex:1 0 100%;padding:8px 8px 4px 17px;margin-top:2px;
  border-top:1px solid rgba(103,232,249,0.14);color:#dbe4ff;
  white-space:pre-wrap;overflow-wrap:anywhere;font:500 11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.phren-pp-row.active .phren-pp-rowdetail{display:block}
.phren-pp-row.editing{flex-wrap:wrap;background:rgba(103,232,249,0.1);border-color:rgba(103,232,249,0.62);box-shadow:inset 3px 0 #67e8f9}
.phren-pp-inline-editor{display:flex;flex:1 0 100%;flex-direction:column;gap:9px;padding:9px 7px 5px 17px;margin-top:3px;border-top:1px solid rgba(103,232,249,0.18)}
.phren-pp-inline-editor textarea{
  width:100%;min-height:132px;resize:vertical;padding:10px 11px;border-radius:8px;
  border:1px solid rgba(103,232,249,0.28);background:rgba(5,7,17,0.92);color:#edf4ff;
  outline:none;font:500 11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.phren-pp-inline-editor textarea:focus{border-color:#67e8f9;box-shadow:0 0 0 1px rgba(103,232,249,0.18)}
.phren-pp-inline-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
.phren-pp-inline-fields label{display:flex;flex-direction:column;gap:5px;color:#8b96c9;font:700 8.5px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-transform:uppercase;letter-spacing:.08em}
.phren-pp-inline-fields select{min-width:0;padding:7px 8px;border-radius:7px;border:1px solid rgba(103,232,249,.22);background:rgba(12,15,30,.96);color:#dbe4ff;font:600 10px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.phren-pp-inline-meta{display:flex;flex-wrap:wrap;gap:7px;color:#8b96c9;font:600 9px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.phren-pp-inline-meta span{padding:3px 7px;border-radius:999px;border:1px solid rgba(103,232,249,.14);background:rgba(12,15,30,.75)}
.phren-pp-inline-actions{display:flex;justify-content:flex-end;gap:7px}
.phren-pp-inline-actions button{padding:6px 11px;border-radius:7px;cursor:pointer;border:1px solid rgba(103,232,249,.25);background:rgba(12,15,30,.9);color:#bfc9ec;font:700 9px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-transform:uppercase;letter-spacing:.06em}
.phren-pp-inline-actions [data-pp-save]{border-color:rgba(103,232,249,.65);background:rgba(103,232,249,.15);color:#eaffff}
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
.phren-pp-peek{
  flex:0 0 auto;width:22px;height:22px;padding:0;border-radius:6px;cursor:pointer;
  border:1px solid rgba(103,232,249,0.28);background:rgba(103,232,249,0.06);
  color:#67e8f9;font-size:11px;line-height:1;display:none;place-items:center;
}
.phren-pp-row:hover .phren-pp-peek,.phren-pp-row.active .phren-pp-peek{display:grid}
.phren-pp-peek:hover{border-color:rgba(103,232,249,0.7);background:rgba(103,232,249,0.16);color:#aef1ff}
.phren-pp-edit{
  flex:0 0 auto;width:22px;height:22px;padding:0;border-radius:6px;cursor:pointer;
  border:1px solid rgba(255,209,102,0.3);background:rgba(255,209,102,0.08);
  color:#ffd166;font-size:11px;line-height:1;display:none;place-items:center;
}
.phren-pp-row:hover .phren-pp-edit,.phren-pp-row.active .phren-pp-edit{display:grid}
.phren-pp-edit:hover{border-color:rgba(255,209,102,0.7);background:rgba(255,209,102,0.18);color:#ffe1a3}
.phren-pp-check{
  flex:0 0 auto;width:15px;height:15px;border-radius:4px;display:grid;place-items:center;
  border:1px solid rgba(103,232,249,0.35);background:rgba(12,15,30,0.9);
  font-size:10px;line-height:1;color:#05060f;
}
.phren-pp-row.picked .phren-pp-check{background:#67e8f9;border-color:#67e8f9}
.phren-pp-row.picked{background:rgba(103,232,249,0.08);border-color:rgba(103,232,249,0.3)}
.phren-pp-bulk{
  display:flex;align-items:center;gap:8px;padding:9px 12px;
  border-top:1px solid rgba(103,232,249,0.16);background:rgba(10,13,26,0.96);
}
.phren-pp-bulk[hidden]{display:none}
.phren-pp-bulk-count{
  flex:1 1 auto;font:600 10px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#8b96c9;letter-spacing:0.05em;
}
.phren-pp-bulk button{
  cursor:pointer;padding:6px 10px;border-radius:7px;
  font:650 9.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:0.05em;text-transform:uppercase;
  border:1px solid rgba(103,232,249,0.2);background:rgba(12,15,30,0.9);color:#c3ccef;
}
.phren-pp-bulk button:hover{border-color:rgba(103,232,249,0.5);color:#eaf2ff}
.phren-pp-bulk button[data-pp-bulk-delete]{
  border-color:rgba(255,84,112,0.4);color:#ff7b93;background:rgba(255,84,112,0.08);
}
.phren-pp-bulk button[data-pp-bulk-delete]:hover{border-color:rgba(255,84,112,0.75);color:#ffb3c1}
.phren-pp-bulk button[data-pp-bulk-delete][disabled]{opacity:0.4;cursor:default}
.phren-pp-empty{padding:22px 12px;text-align:center;color:#5b6488;
  font:600 10px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.06em}
@media (max-width: 900px){.phren-project-panel{width:min(300px, calc(100% - 32px))}}
@media (prefers-reduced-motion: reduce){.phren-project-panel{animation:none}}
`;

function injectPanelCss(): void {
  if (document.getElementById("phren-project-panel-css")) return;
  const style = document.createElement("style");
  style.id = "phren-project-panel-css";
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

let panelEl: HTMLElement | null = null;
let reopenEl: HTMLElement | null = null;
let renderedProjectId: string | null = null;
let renderedFragmentId: string | null = null;
let renderedReview = false;
let cursorId: string | null = null;
let collapsed = false;
let selectMode = false;
let editingId: string | null = null;
let reviewMode = false; // global "needs review" pane (aging findings, all projects)
let panelWidth: number | null = null; // user-resized width (px), null = default
let panelHeight: number | null = null; // user-resized height (px), null = default
let panelLeft: number | null = null;
let panelTop: number | null = null;
const picked = new Set<string>();

/** Count of aging (decaying/stale) findings across every project. */
export function countAgingFindings(): number {
  return state.rawNodes.reduce(
    (n, node) => n + (node.kind === "finding" && node.health !== "healthy" ? 1 : 0),
    0,
  );
}

/** Open (or refresh) the cross-project review pane. */
export function openReviewPane(): void {
  reviewMode = true;
  refreshProjectPanel({ data: true });
}

/** Rebuild whichever pane is currently active (project / fragment / review). */
function rebuildPane(): void {
  if (reviewMode) buildReviewPanel();
  else if (renderedFragmentId) buildFragmentPanel(renderedFragmentId);
  else if (renderedProjectId) buildPanel(renderedProjectId);
}

/** Re-render just the row list for the active pane. */
function renderCurrentList(): void {
  if (reviewMode) renderReviewList();
  else renderList();
}

// Host offsets: browser keeps its dossier on the left and contents on the
// right; VS Code uses the contents pane as its sole persistent left surface.
const PANE_LEFT = 16;
const PANE_RIGHT = 58;

function isVsCodeHost(): boolean {
  return document.body.classList.contains("phren-vscode-webview");
}

// Persisted UI preferences (size, collapsed, sort) — survive reloads in both
// hosts via localStorage. Filters/query stay transient (reset each session).
const PREFS_KEY = "phren.graph.pane";
let prefsLoaded = false;
function loadPrefs(): void {
  if (prefsLoaded) return;
  prefsLoaded = true;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as { width?: unknown; height?: unknown; left?: unknown; top?: unknown; collapsed?: unknown; sort?: unknown };
    if (typeof p.width === "number" && p.width > 0) panelWidth = p.width;
    if (typeof p.height === "number" && p.height > 0) panelHeight = p.height;
    if (typeof p.left === "number" && p.left >= 0) panelLeft = p.left;
    if (typeof p.top === "number" && p.top >= 0) panelTop = p.top;
    if (typeof p.collapsed === "boolean") collapsed = p.collapsed;
    if (p.sort === "aging" || p.sort === "recent" || p.sort === "az") filters.sort = p.sort;
  } catch { /* storage unavailable — use defaults */ }
}
function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ width: panelWidth, height: panelHeight, left: panelLeft, top: panelTop, collapsed, sort: filters.sort }));
  } catch { /* ignore */ }
}

/** Begin an edge-drag resize of the pane. */
function startResize(event: PointerEvent): void {
  if (!panelEl || !state.container) return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget as HTMLElement;
  handle.classList.add("dragging");
  try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  const onMove = (ev: PointerEvent) => {
    if (!panelEl || !state.container) return;
    const rect = state.container.getBoundingClientRect();
    const width = isVsCodeHost()
      ? clamp(ev.clientX - rect.left - PANE_LEFT, 260, Math.max(260, rect.width - 420))
      : clamp(rect.right - PANE_RIGHT - ev.clientX, 260, Math.max(260, rect.width - 420));
    panelWidth = width;
    panelEl.style.width = `${width}px`;
  };
  const onUp = () => {
    handle.classList.remove("dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    savePrefs();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function startHeightResize(event: PointerEvent): void {
  if (!panelEl || !state.container) return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget as HTMLElement;
  handle.classList.add("dragging");
  try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  const onMove = (ev: PointerEvent) => {
    if (!panelEl || !state.container) return;
    const pane = panelEl.getBoundingClientRect();
    const container = state.container.getBoundingClientRect();
    const height = clamp(ev.clientY - pane.top, 320, Math.max(320, container.bottom - pane.top - 16));
    panelHeight = height;
    panelEl.style.height = `${height}px`;
  };
  const onUp = () => {
    handle.classList.remove("dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    savePrefs();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function startPanelDrag(event: PointerEvent): void {
  if (!panelEl || !state.container || !isVsCodeHost()) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button,input,select,textarea,a")) return;
  event.preventDefault();
  event.stopPropagation();
  const pane = panelEl.getBoundingClientRect();
  const offsetX = event.clientX - pane.left;
  const offsetY = event.clientY - pane.top;
  const onMove = (ev: PointerEvent) => {
    if (!panelEl || !state.container) return;
    const bounds = state.container.getBoundingClientRect();
    const box = panelEl.getBoundingClientRect();
    panelLeft = clamp(ev.clientX - bounds.left - offsetX, 8, Math.max(8, bounds.width - box.width - 8));
    panelTop = clamp(ev.clientY - bounds.top - offsetY, 8, Math.max(8, bounds.height - box.height - 8));
    panelEl.style.left = `${panelLeft}px`;
    panelEl.style.right = "auto";
    panelEl.style.top = `${panelTop}px`;
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    savePrefs();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function startCornerResize(event: PointerEvent): void {
  if (!panelEl || !state.container) return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget as HTMLElement;
  handle.classList.add("dragging");
  const onMove = (ev: PointerEvent) => {
    if (!panelEl || !state.container) return;
    const pane = panelEl.getBoundingClientRect();
    const container = state.container.getBoundingClientRect();
    panelWidth = isVsCodeHost()
      ? clamp(ev.clientX - pane.left, 260, Math.max(260, container.right - pane.left - 16))
      : clamp(pane.right - ev.clientX, 260, Math.max(260, pane.right - container.left - 16));
    panelHeight = clamp(ev.clientY - pane.top, 320, Math.max(320, container.bottom - pane.top - 16));
    panelEl.style.width = `${panelWidth}px`;
    panelEl.style.height = `${panelHeight}px`;
  };
  const onUp = () => {
    handle.classList.remove("dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    savePrefs();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
const filters = {
  query: "",
  kind: "all" as "all" | "finding" | "task",
  health: "all" as "all" | "aging" | "healthy" | "decaying" | "stale",
  sort: "aging" as "aging" | "recent" | "az",
};

/** Shared pane header (kind eyebrow · name · sub-line · optional extra block). */
function paneHeadHtml(opts: { kind: string; name: string; sub: string; extra?: string; kindStyle?: string }): string {
  return [
    '<div class="phren-pp-head">',
    '<div class="phren-pp-title">',
    `<div class="phren-pp-kind"${opts.kindStyle ? ` style="${opts.kindStyle}"` : ""}>${opts.kind}</div>`,
    `<div class="phren-pp-name" title="${esc(opts.name)}">${esc(opts.name)}</div>`,
    `<div class="phren-pp-sub">${opts.sub}</div>`,
    opts.extra || "",
    "</div>",
    '<div class="phren-pp-headbtns">',
    '<button type="button" class="phren-pp-iconbtn" data-pp-collapse aria-label="Collapse panel" title="Collapse">›</button>',
    '<button type="button" class="phren-pp-iconbtn" data-pp-close aria-label="Close" title="Close">×</button>',
    "</div>",
    "</div>",
  ].join("");
}

// Shared bulk-action footer (project + review panes). Merge is revealed by
// renderBulkBar only when exactly two same-project findings are picked.
const BULK_BAR_HTML = [
  '<div class="phren-pp-bulk" data-pp-bulk hidden>',
  '<span class="phren-pp-bulk-count" data-pp-bulk-count>0 selected</span>',
  '<button type="button" data-pp-bulk-merge hidden>Merge</button>',
  '<button type="button" data-pp-bulk-all>Select all</button>',
  '<button type="button" data-pp-bulk-delete disabled>Delete</button>',
  '<button type="button" data-pp-bulk-done>Done</button>',
  "</div>",
].join("");

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

/** Show/refresh the slim re-open tab shown while the pane is collapsed. */
function showReopenTab(projectName: string): void {
  if (!state.container) return;
  if (!reopenEl || !reopenEl.isConnected) {
    reopenEl = document.createElement("button");
    reopenEl.setAttribute("type", "button");
    reopenEl.className = "phren-pp-reopen";
    reopenEl.setAttribute("aria-label", "Expand project contents");
    reopenEl.addEventListener("click", (event) => {
      event.stopPropagation();
      collapsed = false;
      savePrefs();
      refreshProjectPanel();
    });
    reopenEl.addEventListener("pointerdown", (event) => event.stopPropagation());
    state.container.appendChild(reopenEl);
  }
  reopenEl.innerHTML = `<span aria-hidden="true">‹</span><span class="phren-pp-reopen-label">${esc(projectName)}</span>`;
  reopenEl.removeAttribute("hidden");
}

function hideReopenTab(): void {
  reopenEl?.setAttribute("hidden", "");
}

function projectNodeByName(name: string): RuntimeNode | undefined {
  return state.rawNodes.find((node) => node.kind === "project" && (node.project || node.id) === name);
}

type PaneContext = { kind: "project" | "fragment"; id: string };

/** What the pane should show: a project's contents, a fragment's network, or nothing. */
function contextNode(): PaneContext | null {
  if (state.focusedProjectId) return { kind: "project", id: state.focusedProjectId };
  if (state.selectedNodeId) {
    const node = state.nodeById.get(state.selectedNodeId);
    if (node) {
      if (node.kind === "project") return { kind: "project", id: node.id };
      if (node.kind === "entity") return { kind: "fragment", id: node.id };
      if (node.project) {
        const project = projectNodeByName(node.project);
        if (project) return { kind: "project", id: project.id };
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
  const hasActions = state.itemActionCallbacks.length > 0;
  const editing = !selectMode && editingId === node.id;
  const active = !selectMode && state.selectedNodeId === node.id ? " active" : "";
  const isPicked = selectMode && picked.has(node.id) ? " picked" : "";
  const dotColor = node.kind === "task" ? node.baseColor : HEALTH_COLOR[node.health] || "#8b96c9";
  const label = node.fullLabel || node.label || node.id;
  const preview = node.label || label;
  const chip = node.kind === "task"
    ? (node.section || "task")
    : (node.topicLabel || node.topicSlug || node.health);
  // In select mode rows carry a checkbox; otherwise hover actions: peek (fly the
  // camera without opening the dossier) and delete (only when a host supports it).
  const check = selectMode ? `<span class="phren-pp-check">${picked.has(node.id) ? "✓" : ""}</span>` : "";
  const peek = !selectMode ? `<span class="phren-pp-peek" data-pp-peek title="Show in graph">◎</span>` : "";
  const edit = !selectMode && hasActions
    ? `<span class="phren-pp-edit" data-pp-edit title="Edit this ${esc(node.kind)}">✎</span>`
    : "";
  const del = !selectMode && hasActions
    ? `<span class="phren-pp-del" data-pp-del title="Delete this ${esc(node.kind)}">🗑</span>`
    : "";
  const taskFields = node.kind === "task"
    ? `<div class="phren-pp-inline-fields">`
      + `<label>Status<select data-pp-section>`
      + ["Queue", "Active", "Done"].map((value) => `<option value="${value}"${node.section === value ? " selected" : ""}>${value}</option>`).join("")
      + `</select></label>`
      + `<label>Priority<select data-pp-priority>`
      + [["", "None"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]].map(([value, text]) => `<option value="${value}"${(node.priority || "") === value ? " selected" : ""}>${text}</option>`).join("")
      + `</select></label></div>`
    : `<div class="phren-pp-inline-meta"><span>Topic · ${esc(node.topicLabel || node.topicSlug || "General")}</span><span>Health · ${esc(node.health)}</span></div>`;
  const inlineEditor = editing
    ? `<div class="phren-pp-inline-editor" data-pp-editor>`
      + `<textarea data-pp-text aria-label="Edit ${esc(node.kind)} text">${esc(label)}</textarea>`
      + taskFields
      + `<div class="phren-pp-inline-actions"><button type="button" data-pp-cancel>Cancel</button><button type="button" data-pp-save>Save</button></div>`
      + `</div>`
    : `<span class="phren-pp-rowdetail">${esc(label)}</span>`;
  return (
    `<div class="phren-pp-row${active}${isPicked}${editing ? " editing" : ""}" data-node-id="${esc(node.id)}" role="button" tabindex="0" aria-expanded="${Boolean(active || editing)}" title="${esc(label)}">` +
    check +
    `<span class="phren-pp-dot" style="background:${esc(dotColor)};color:${esc(dotColor)}"></span>` +
    `<span class="phren-pp-rowlabel">${esc(preview)}</span>` +
    `<span class="phren-pp-rowchip">${esc(chip)}</span>` +
    peek +
    edit +
    del +
    inlineEditor +
    `</div>`
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
    renderBulkBar();
    return;
  }
  let html = "";
  if (findings.length) {
    html += `<div class="phren-pp-group"><span class="phren-pp-group-label">Findings</span><span class="phren-pp-group-count">${findings.length}</span></div>`;
    html += findings.map(rowHtml).join("");
  }
  if (tasks.length) {
    html += `<div class="phren-pp-group"><span class="phren-pp-group-label">Tasks</span><span class="phren-pp-group-count">${tasks.length}</span></div>`;
    html += tasks.map(rowHtml).join("");
  }
  listEl.innerHTML = html;
  // Drop the cursor if its row was filtered out; otherwise repaint it.
  if (cursorId && !rowIdsInOrder().includes(cursorId)) cursorId = null;
  paintCursor();
  renderBulkBar();
}

/** Enter/leave multi-select mode (rebuilds so checkboxes + bulk bar appear). */
function setSelectMode(on: boolean): void {
  selectMode = on;
  if (!on) picked.clear();
  rebuildPane();
}

/** Refresh the bulk-action footer (count, delete-enabled, visibility). */
function renderBulkBar(): void {
  if (!panelEl) return;
  const bar = panelEl.querySelector<HTMLElement>("[data-pp-bulk]");
  if (!bar) return;
  if (!selectMode) { bar.setAttribute("hidden", ""); return; }
  bar.removeAttribute("hidden");
  const count = bar.querySelector<HTMLElement>("[data-pp-bulk-count]");
  if (count) count.textContent = `${picked.size} selected`;
  const del = bar.querySelector<HTMLButtonElement>("[data-pp-bulk-delete]");
  if (del) {
    del.disabled = picked.size === 0;
    del.textContent = picked.size ? `Delete ${picked.size}` : "Delete";
  }
  // Merge is offered only for exactly two same-project findings.
  const merge = bar.querySelector<HTMLButtonElement>("[data-pp-bulk-merge]");
  if (merge) merge.toggleAttribute("hidden", !mergeEligible());
  const allButton = bar.querySelector<HTMLButtonElement>("[data-pp-bulk-all]");
  if (allButton) {
    const visibleIds = rowIdsInOrder();
    const allVisiblePicked = visibleIds.length > 0 && visibleIds.every((id) => picked.has(id));
    allButton.textContent = allVisiblePicked ? "Unselect all" : "Select all";
  }
}

/** True when the current picks are exactly two findings in the same project. */
function mergeEligible(): boolean {
  if (picked.size !== 2) return false;
  const nodes = [...picked].map((id) => state.nodeById.get(id));
  return nodes.every((n) => n?.kind === "finding") && nodes[0]?.project === nodes[1]?.project;
}

/** Hand the two picked findings to the host to merge into one. */
function commitMerge(): void {
  if (!mergeEligible()) return;
  const details = [...picked]
    .map((id) => nodeDetail(id))
    .filter((detail): detail is NodeDetail => Boolean(detail));
  if (details.length !== 2) return;
  state.itemActionCallbacks.forEach((cb) => cb(details, "merge"));
  selectMode = false;
  picked.clear();
}

/** Hand the picked items to the host as a batch delete, then leave select mode. */
function commitBulkDelete(): void {
  if (!picked.size) return;
  const details = [...picked]
    .map((id) => nodeDetail(id))
    .filter((detail): detail is NodeDetail => Boolean(detail));
  if (!details.length) return;
  state.itemActionCallbacks.forEach((cb) => cb(details, "delete-batch"));
  // The host deletes + refreshes (which rebuilds the pane); leave select mode.
  selectMode = false;
  picked.clear();
}

/** Create the pane element (once) with its shared pointer/keyboard handlers. */
function ensurePanelEl(): void {
  if (!state.container) return;
  injectPanelCss();
  if (panelEl && panelEl.isConnected) return;
  panelEl = document.createElement("aside");
  panelEl.className = "phren-project-panel";
  panelEl.setAttribute("aria-label", "Project contents");
  {
    // Inside the force-graph container: stop the pointer sequence so ForceGraph
    // doesn't read it as a background click and clear the selection.
    panelEl.addEventListener("pointerdown", (event) => event.stopPropagation());
    panelEl.addEventListener("click", (event) => {
      event.stopPropagation();
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-pp-close]")) {
        reviewMode = false;
        clearSelection();
        refreshProjectPanel();
        return;
      }
      if (target?.closest("[data-pp-collapse]")) {
        collapsed = true;
        savePrefs();
        refreshProjectPanel();
        return;
      }
      if (target?.closest("[data-pp-select]")) {
        setSelectMode(!selectMode);
        return;
      }
      if (target?.closest("[data-pp-bulk-all]")) {
        const visibleIds = rowIdsInOrder();
        const allVisiblePicked = visibleIds.length > 0 && visibleIds.every((rid) => picked.has(rid));
        visibleIds.forEach((rid) => allVisiblePicked ? picked.delete(rid) : picked.add(rid));
        renderCurrentList();
        renderBulkBar();
        return;
      }
      if (target?.closest("[data-pp-bulk-done]")) {
        setSelectMode(false);
        return;
      }
      if (target?.closest("[data-pp-bulk-delete]")) {
        commitBulkDelete();
        return;
      }
      if (target?.closest("[data-pp-bulk-merge]")) {
        commitMerge();
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
      if (target?.closest("[data-pp-cancel]")) {
        editingId = null;
        renderCurrentList();
        return;
      }
      if (target?.closest("[data-pp-save]")) {
        const detail = nodeDetail(id);
        const text = row.querySelector<HTMLTextAreaElement>("[data-pp-text]")?.value.trim() ?? "";
        if (!detail || !text) return;
        detail.editedText = text;
        detail.editedSection = row.querySelector<HTMLSelectElement>("[data-pp-section]")?.value;
        detail.editedPriority = row.querySelector<HTMLSelectElement>("[data-pp-priority]")?.value;
        editingId = null;
        state.itemActionCallbacks.forEach((cb) => cb(detail, "save-inline"));
        renderCurrentList();
        return;
      }
      if (target?.closest("[data-pp-editor]")) return;
      // Select mode: clicking a row toggles its pick instead of flying to it.
      if (selectMode) {
        if (picked.has(id)) picked.delete(id);
        else picked.add(id);
        row.classList.toggle("picked", picked.has(id));
        const check = row.querySelector(".phren-pp-check");
        if (check) check.textContent = picked.has(id) ? "✓" : "";
        renderBulkBar();
        return;
      }
      if (target?.closest("[data-pp-peek]")) {
        peekNode(id);
        return;
      }
      if (target?.closest("[data-pp-edit]")) {
        editingId = id;
        cursorId = id;
        renderCurrentList();
        panelEl?.querySelector<HTMLTextAreaElement>(`[data-node-id="${CSS.escape(id)}"] [data-pp-text]`)?.focus();
        return;
      }
      if (target?.closest("[data-pp-del]")) {
        const detail = nodeDetail(id);
        if (detail) state.itemActionCallbacks.forEach((cb) => cb(detail, "delete"));
        return;
      }
      cursorId = id;
      editingId = null;
      selectNode(id);
    });
    // Keyboard review: ↑/↓ move a cursor row, Enter flies to it, Delete prunes.
    // Works whenever focus is inside the pane (its filter input or a row button).
    panelEl.addEventListener("keydown", (event) => {
      if ((event.target as HTMLElement | null)?.closest("[data-pp-editor]")) return;
      if (event.key === "ArrowDown") { moveCursor(1); event.preventDefault(); }
      else if (event.key === "ArrowUp") { moveCursor(-1); event.preventDefault(); }
      else if (event.key === "Enter" && cursorId) { selectNode(cursorId); event.preventDefault(); }
      else if (event.key === "Delete" && cursorId && state.itemActionCallbacks.length) {
        const detail = nodeDetail(cursorId);
        if (detail) state.itemActionCallbacks.forEach((cb) => cb(detail, "delete"));
        event.preventDefault();
      }
    });
  }
  state.container.appendChild(panelEl);
}

function buildPanel(projectId: string): void {
  if (!state.container) return;
  ensurePanelEl();
  if (!panelEl) return;

  const project = state.nodeById.get(projectId);
  const projectName = project ? project.label || project.project || project.id : "";
  const all = project ? projectItems(project.project || project.id) : [];
  const findingItems = all.filter((n) => n.kind === "finding");
  const loadedFindingCount = findingItems.length;
  const findingCount = typeof project?.findingCount === "number" ? project.findingCount : loadedFindingCount;
  const loadedTaskCount = all.length - loadedFindingCount;
  const taskCount = typeof project?.taskCount === "number" ? project.taskCount : loadedTaskCount;

  // Memory-health tally across the project's findings — a stacked bar plus a
  // clickable key so aging memory is visible (and filterable) at a glance.
  const health = { healthy: 0, decaying: 0, stale: 0 };
  for (const f of findingItems) health[f.health]++;
  const total = loadedFindingCount || 1;
  const seg = (n: number, color: string) => (n ? `<span style="width:${(n / total) * 100}%;background:${color}"></span>` : "");
  const healthBar = loadedFindingCount
    ? `<div class="phren-pp-health" title="${health.healthy} healthy · ${health.decaying} decaying · ${health.stale} stale">`
      + seg(health.healthy, HEALTH_COLOR.healthy) + seg(health.decaying, HEALTH_COLOR.decaying) + seg(health.stale, HEALTH_COLOR.stale)
      + "</div>"
      + '<div class="phren-pp-healthkey">'
      + `<button type="button" class="${filters.health === "healthy" ? "active" : ""}" aria-pressed="${filters.health === "healthy"}" data-pp-health-key="healthy"><i style="background:${HEALTH_COLOR.healthy}"></i>${health.healthy} healthy</button>`
      + `<button type="button" class="${filters.health === "decaying" ? "active" : ""}" aria-pressed="${filters.health === "decaying"}" data-pp-health-key="decaying"><i style="background:${HEALTH_COLOR.decaying}"></i>${health.decaying} decaying</button>`
      + `<button type="button" class="${filters.health === "stale" ? "active" : ""}" aria-pressed="${filters.health === "stale"}" data-pp-health-key="stale"><i style="background:${HEALTH_COLOR.stale}"></i>${health.stale} stale</button>`
      + "</div>"
    : "";

  panelEl.innerHTML = [
    paneHeadHtml({
      kind: "Project",
      name: projectName,
      sub: `${findingCount} findings · ${taskCount} tasks`,
      extra: healthBar,
    }),
    '<div class="phren-pp-controls">',
    `<input type="text" class="phren-pp-search" data-pp-search placeholder="Filter in project…" value="${esc(filters.query)}" />`,
    '<div class="phren-pp-chips" aria-label="Content filters">',
    `<button type="button" class="phren-pp-chip${filters.kind === "all" ? " on" : ""}" aria-pressed="${filters.kind === "all"}" data-pp-chip data-kind="all">All</button>`,
    `<button type="button" class="phren-pp-chip${filters.kind === "finding" ? " on" : ""}" aria-pressed="${filters.kind === "finding"}" data-pp-chip data-kind="finding">Findings</button>`,
    `<button type="button" class="phren-pp-chip${filters.kind === "task" ? " on" : ""}" aria-pressed="${filters.kind === "task"}" data-pp-chip data-kind="task">Tasks</button>`,
    `<button type="button" class="phren-pp-chip${filters.health === "aging" ? " on" : ""}" aria-pressed="${filters.health === "aging"}" data-pp-chip data-health="aging" title="Show only decaying or stale">⚠ Aging</button>`,
    state.itemActionCallbacks.length
      ? `<button type="button" class="phren-pp-chip${selectMode ? " on" : ""}" aria-pressed="${selectMode}" data-pp-select title="Select multiple items">Select</button>`
      : "",
    "</div>",
    '<div class="phren-pp-tools">',
    `<select class="phren-pp-sort" data-pp-sort aria-label="Sort items" title="Sort">`,
    `<option value="aging"${filters.sort === "aging" ? " selected" : ""}>Aging first</option>`,
    `<option value="recent"${filters.sort === "recent" ? " selected" : ""}>Recent</option>`,
    `<option value="az"${filters.sort === "az" ? " selected" : ""}>A–Z</option>`,
    "</select>",
    "</div>",
    "</div>",
    '<div class="phren-pp-list" data-pp-list></div>',
    BULK_BAR_HTML,
  ].join("");

  // Keep any user-chosen width and (re)attach the edge resize handle (the
  // innerHTML above wiped the previous one).
  attachResizeAndWidth();

  const searchInput = panelEl.querySelector<HTMLInputElement>("[data-pp-search]");
  searchInput?.addEventListener("input", () => {
    filters.query = searchInput.value;
    renderList();
  });

  const sortSelect = panelEl.querySelector<HTMLSelectElement>("[data-pp-sort]");
  sortSelect?.addEventListener("change", () => {
    filters.sort = (sortSelect.value as typeof filters.sort) || "aging";
    savePrefs();
    renderList();
  });

  renderedProjectId = projectId;
  renderedFragmentId = null;
  renderList();
  syncActiveRow();
}

/** Independent resize handles + saved dimensions, shared by every pane mode. */
function attachResizeAndWidth(): void {
  if (!panelEl || !state.container) return;
  if (panelWidth) {
    const cw = state.container.getBoundingClientRect().width;
    panelEl.style.width = `${clamp(panelWidth, 260, Math.max(260, cw - 420))}px`;
  }
  if (panelHeight) {
    const ch = state.container.getBoundingClientRect().height;
    panelEl.style.height = `${clamp(panelHeight, 320, Math.max(320, ch - 80))}px`;
  }
  const resize = document.createElement("div");
  resize.className = "phren-pp-resize";
  resize.setAttribute("aria-hidden", "true");
  resize.addEventListener("pointerdown", startResize);
  panelEl.appendChild(resize);
  const resizeY = document.createElement("div");
  resizeY.className = "phren-pp-resize-y";
  resizeY.setAttribute("role", "separator");
  resizeY.setAttribute("aria-orientation", "horizontal");
  resizeY.setAttribute("aria-label", "Resize pane height");
  resizeY.addEventListener("pointerdown", startHeightResize);
  panelEl.appendChild(resizeY);
  const resizeXY = document.createElement("div");
  resizeXY.className = "phren-pp-resize-xy";
  resizeXY.setAttribute("role", "separator");
  resizeXY.setAttribute("aria-label", "Resize pane width and height");
  resizeXY.addEventListener("pointerdown", startCornerResize);
  panelEl.appendChild(resizeXY);
  panelEl.querySelector<HTMLElement>(".phren-pp-head")?.addEventListener("pointerdown", startPanelDrag);
}

/** Keep the working pane in one predictable place instead of chasing nodes. */
function positionPaneBesideNode(_nodeId: string): void {
  if (!panelEl) return;
  if (isVsCodeHost()) {
    panelEl.style.left = `${panelLeft ?? 16}px`;
    panelEl.style.right = "auto";
  } else {
    panelEl.style.left = "auto";
    panelEl.style.right = "58px";
  }
  panelEl.style.top = `${isVsCodeHost() ? panelTop ?? 64 : 64}px`;
}

/** Render the pane for a fragment (entity): its connected projects + references. */
function buildFragmentPanel(entityId: string): void {
  if (!state.container) return;
  ensurePanelEl();
  if (!panelEl) return;

  const node = state.nodeById.get(entityId);
  const name = node ? node.label || node.id : "fragment";
  const type = node?.entityType || "fragment";
  const refCount = node?.refCount || 0;
  const adj = state.fullAdjacency.get(entityId) || new Set<string>();
  const neighbors = [...adj]
    .map((id) => state.nodeById.get(id))
    .filter((n): n is RuntimeNode => Boolean(n));
  const byName = (a: RuntimeNode, b: RuntimeNode) => (a.label || "").localeCompare(b.label || "");
  const projects = neighbors.filter((n) => n.kind === "project").sort(byName);
  const refs = neighbors.filter((n) => n.kind === "reference").sort(byName);

  const fragRow = (n: RuntimeNode, chip: string) => {
    const dot = n.baseColor || "#8b96c9";
    const label = n.label || n.id;
    const active = state.selectedNodeId === n.id ? " active" : "";
    return (
      `<button type="button" class="phren-pp-row${active}" data-node-id="${esc(n.id)}" title="${esc(label)}">` +
      `<span class="phren-pp-dot" style="background:${esc(dot)};color:${esc(dot)}"></span>` +
      `<span class="phren-pp-rowlabel">${esc(label)}</span>` +
      `<span class="phren-pp-rowchip">${esc(chip)}</span>` +
      `<span class="phren-pp-peek" data-pp-peek title="Show in graph">◎</span>` +
      "</button>"
    );
  };
  const projItems = (n: RuntimeNode) => {
    const f = typeof n.findingCount === "number" ? n.findingCount : 0;
    const t = typeof n.taskCount === "number" ? n.taskCount : 0;
    return `${f + t} items`;
  };

  const rows: string[] = [];
  if (projects.length) {
    rows.push(`<div class="phren-pp-group">Connected projects · ${projects.length}</div>`);
    rows.push(...projects.map((p) => fragRow(p, projItems(p))));
  }
  if (refs.length) {
    rows.push(`<div class="phren-pp-group">References · ${refs.length}</div>`);
    rows.push(...refs.map((r) => fragRow(r, "ref")));
  }
  if (!rows.length) rows.push('<div class="phren-pp-empty">No connections</div>');

  panelEl.innerHTML = [
    paneHeadHtml({
      kind: "Fragment",
      name,
      sub: `${esc(type)} · ${refCount} refs · ${projects.length} project${projects.length === 1 ? "" : "s"}`,
    }),
    `<div class="phren-pp-list" data-pp-list>${rows.join("")}</div>`,
  ].join("");

  attachResizeAndWidth();
  renderedFragmentId = entityId;
  renderedProjectId = null;
}

/** All aging (decaying/stale) findings, grouped by project, newest-worst first. */
function agingByProject(): Array<{ project: string; items: RuntimeNode[] }> {
  const q = filters.query.trim().toLowerCase();
  const groups = new Map<string, RuntimeNode[]>();
  for (const node of state.rawNodes) {
    if (node.kind !== "finding" || node.health === "healthy") continue;
    if (q && !node.searchText.includes(q)) continue;
    const key = node.project || "—";
    const list = groups.get(key) ?? (groups.set(key, []).get(key) as RuntimeNode[]);
    list.push(node);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, items]) => ({
      project,
      items: items.sort((a, b) => HEALTH_RANK[b.health] - HEALTH_RANK[a.health]),
    }));
}

function renderReviewList(): void {
  if (!panelEl) return;
  const listEl = panelEl.querySelector<HTMLElement>("[data-pp-list]");
  if (!listEl) return;
  const groups = agingByProject();
  if (!groups.length) {
    listEl.innerHTML = `<div class="phren-pp-empty">Nothing needs review 🎉</div>`;
    cursorId = null;
    renderBulkBar();
    return;
  }
  listEl.innerHTML = groups
    .map((g) => `<div class="phren-pp-group">${esc(g.project)} · ${g.items.length}</div>` + g.items.map(rowHtml).join(""))
    .join("");
  if (cursorId && !rowIdsInOrder().includes(cursorId)) cursorId = null;
  paintCursor();
  renderBulkBar();
}

/** Cross-project review pane: every aging finding, ready to prune in bulk. */
function buildReviewPanel(): void {
  if (!state.container) return;
  ensurePanelEl();
  if (!panelEl) return;

  const total = countAgingFindings();
  panelEl.innerHTML = [
    paneHeadHtml({
      kind: "⚠ Needs review",
      kindStyle: "color:#ffb648",
      name: `${total} aging finding${total === 1 ? "" : "s"}`,
      sub: "decaying + stale, across all projects",
    }),
    '<div class="phren-pp-controls">',
    `<input type="text" class="phren-pp-search" data-pp-search placeholder="Filter aging findings…" value="${esc(filters.query)}" />`,
    '<div class="phren-pp-tools">',
    state.itemActionCallbacks.length
      ? `<button type="button" class="phren-pp-chip${selectMode ? " on" : ""}" aria-pressed="${selectMode}" data-pp-select title="Select multiple items">Select</button>`
      : "",
    "</div>",
    "</div>",
    '<div class="phren-pp-list" data-pp-list></div>',
    BULK_BAR_HTML,
  ].join("");

  attachResizeAndWidth();
  const searchInput = panelEl.querySelector<HTMLInputElement>("[data-pp-search]");
  searchInput?.addEventListener("input", () => {
    filters.query = searchInput.value;
    renderReviewList();
  });

  renderedProjectId = null;
  renderedFragmentId = null;
  renderReviewList();
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
    el.setAttribute("aria-pressed", String(on));
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
    const id = row.getAttribute("data-node-id");
    const on = id === state.selectedNodeId;
    const editing = id === editingId;
    row.classList.toggle("active", on);
    row.classList.toggle("editing", editing);
    row.setAttribute("aria-expanded", String(on || editing));
    if (on || editing) active = row;
  });
  (active as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
}

/**
 * Recompute context and reconcile the pane: hide when no project is in context,
 * fully (re)build when the context project changes, else just move the active
 * row highlight. Cheap enough to call on every selection / filter change.
 */
export function refreshProjectPanel(opts?: { data?: boolean; transitioning?: boolean; forceOpen?: boolean }): void {
  if (!state.container) return;
  loadPrefs();

  if (opts?.transitioning) {
    panelEl?.setAttribute("hidden", "");
    hideReopenTab();
    setLegendHidden(false);
    return;
  }
  if (opts?.forceOpen) {
    collapsed = false;
    savePrefs();
  }

  // Focusing a project exits the global review pane.
  if (reviewMode && state.focusedProjectId) reviewMode = false;

  // Global review pane: every aging finding across projects (selection-driven
  // context is ignored while it's open).
  if (reviewMode) {
    setLegendHidden(true);
    if (collapsed) {
      if (panelEl) panelEl.setAttribute("hidden", "");
      showReopenTab("needs review");
      return;
    }
    hideReopenTab();
    if (!renderedReview || !panelEl || !panelEl.isConnected) {
      buildReviewPanel();
      renderedReview = true;
    } else if (opts?.data) {
      renderReviewList();
    }
    panelEl?.removeAttribute("hidden");
    syncActiveRow();
    return;
  }
  renderedReview = false;

  const ctx = contextNode();
  if (!ctx) {
    if (panelEl) {
      panelEl.setAttribute("hidden", "");
      panelEl.innerHTML = "";
    }
    hideReopenTab();
    renderedProjectId = null;
    renderedFragmentId = null;
    setLegendHidden(false);
    return;
  }
  setLegendHidden(true);

  // Collapsed: hide the full pane, show a slim re-open tab instead.
  if (collapsed) {
    if (panelEl) panelEl.setAttribute("hidden", "");
    const node = state.nodeById.get(ctx.id);
    showReopenTab(node ? node.label || node.project || node.id : ctx.kind);
    return;
  }
  hideReopenTab();

  // Fragment context: a node's connected projects + references.
  if (ctx.kind === "fragment") {
    if (ctx.id !== renderedFragmentId || !panelEl || !panelEl.isConnected) {
      selectMode = false;
      picked.clear();
      buildFragmentPanel(ctx.id);
    }
    panelEl?.removeAttribute("hidden");
    positionPaneBesideNode(state.selectedNodeId || ctx.id);
    syncActiveRow();
    return;
  }

  // Project context.
  if (ctx.id !== renderedProjectId || !panelEl || !panelEl.isConnected) {
    // Switching projects drops any in-progress multi-select (picks are per-project).
    if (ctx.id !== renderedProjectId) { selectMode = false; picked.clear(); }
    buildPanel(ctx.id);
    panelEl?.removeAttribute("hidden");
    positionPaneBesideNode(state.selectedNodeId || ctx.id);
    return;
  }
  panelEl.removeAttribute("hidden");
  positionPaneBesideNode(state.selectedNodeId || ctx.id);
  // If a selected item of this project is being hidden by the kind/health
  // filters, relax them so the selection is never invisible in its own pane
  // (a query the user typed is left intact — that's explicit intent).
  const sel = state.selectedNodeId;
  if (sel && (filters.kind !== "all" || filters.health !== "all")) {
    const node = state.nodeById.get(sel);
    if (node && (node.kind === "finding" || node.kind === "task") && !matchesFilters(node)) {
      filters.kind = "all";
      filters.health = "all";
      buildPanel(ctx.id);
      return;
    }
  }
  // A data change (filter, delete, external refresh) can add/drop rows, so the
  // list is re-rendered; a plain selection change only moves the highlight.
  if (opts?.data) renderList();
  syncActiveRow();
}
