// Holographic chrome for the Graph tab. Appended LAST in the page <style>
// block so it wins the cascade over the base styles. The graph canvas is
// immersive-dark in BOTH app themes (the 3D scene is always a dark void —
// a light chrome ring around it read as unfinished).
export const GRAPH_HUD_STYLES = `
/* ── Full-bleed graph tab — total dark immersion (header included) ── */
body:has(#tab-graph.active) { background: #04050b; }
body:has(#tab-graph.active) .main { max-width: none; padding: 0; }
body:has(#tab-graph.active) .header {
  background: rgba(5, 6, 13, 0.92);
  border-bottom: 1px solid rgba(103, 232, 249, 0.12);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
body:has(#tab-graph.active) .header .nav-item { color: #7f8db8; }
body:has(#tab-graph.active) .header .nav-item.active { color: #67e8f9; }
body:has(#tab-graph.active) .header .brand-name,
body:has(#tab-graph.active) .header-brand { color: #dbe6ff; }
#tab-graph .graph-container {
  background: #04050b;
  border: none;
  border-radius: 0;
  position: relative;
  overflow: hidden;
}
#tab-graph #graph-canvas {
  height: calc(100vh - 64px);
  min-height: 520px;
}

/* ── Overlay chrome — compact HUD clustered top-right (GraphRAG) ──── */
#tab-graph .graph-filters {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  left: auto;
  right: 60px;
  width: min(560px, 60%);
  z-index: 10;
}
#tab-graph .graph-controls { z-index: 10; }
#tab-graph .graph-controls button {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid rgba(103, 232, 249, 0.2);
  background: rgba(8, 10, 22, 0.85);
  color: #9fb2e8;
  font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}
#tab-graph .graph-controls button:hover {
  border-color: rgba(103, 232, 249, 0.55);
  color: #e6f6ff;
}

/* ── Docked dossier — left side, compact (GraphRAG inspector) ─────── */
#graph-node-popover.phren-docked {
  left: 16px !important;
  right: auto !important;
  top: 68px !important;
  bottom: 16px;
  width: 340px;
  max-width: min(360px, calc(100% - 32px));
  pointer-events: none;
  z-index: 12;
}
/* Edge drag handle to widen/narrow the docked dossier (symmetric with the
   contents pane). The popover itself is pointer-transparent, so the handle
   re-enables pointer events for itself. */
#graph-node-popover.phren-docked .phren-dossier-resize {
  position: absolute;
  right: -4px;
  top: 0;
  bottom: 0;
  width: 9px;
  cursor: ew-resize;
  z-index: 20;
  pointer-events: auto;
  touch-action: none;
}
#graph-node-popover.phren-docked .phren-dossier-resize::after {
  content: "";
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 38px;
  border-radius: 999px;
  background: rgba(103, 232, 249, 0.28);
  opacity: 0;
  transition: opacity 0.15s ease;
}
#graph-node-popover.phren-docked .phren-dossier-resize:hover::after,
#graph-node-popover.phren-docked .phren-dossier-resize.dragging::after {
  opacity: 1;
}
/* GraphRAG-style stats row + relationships in the inspector */
.phren-dossier-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid rgba(103, 232, 249, 0.16);
  border-radius: 8px;
  overflow: hidden;
  margin: 12px 0 4px;
}
.phren-dossier-stats > div {
  padding: 8px 10px;
  border-right: 1px solid rgba(103, 232, 249, 0.12);
}
.phren-dossier-stats > div:last-child { border-right: 0; }
.phren-dossier-stats .k {
  font: 700 8.5px/1.4 ui-monospace, Menlo, monospace;
  letter-spacing: 0.12em; color: #6b76a0; text-transform: uppercase;
}
.phren-dossier-stats .v {
  font: 700 14px/1.2 ui-monospace, Menlo, monospace; color: #67e8f9; margin-top: 3px;
}
.phren-rel-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding: 7px 0; border-bottom: 1px solid rgba(120, 150, 220, 0.08); cursor: pointer;
}
.phren-rel-row:last-child { border-bottom: 0; }
.phren-rel-row .n { font-size: 12px; color: #d6e2ff; overflow: hidden; text-overflow: ellipsis; }
.phren-rel-row .n small { display: block; color: #6b76a0; font-size: 10px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.phren-rel-row .w { font: 600 11px/1.4 ui-monospace, Menlo, monospace; color: #67e8f9; font-variant-numeric: tabular-nums; }
.phren-rel-row:hover .n { color: #eaf2ff; }
#graph-node-popover.phren-docked #graph-node-popover-card {
  --surface: #0a0d1e;
  --surface-raised: rgba(22, 27, 52, 0.9);
  --surface-sunken: rgba(5, 6, 15, 0.92);
  --ink: #dbe4ff;
  --muted: #8b96c9;
  --border: rgba(103, 232, 249, 0.2);
  --accent: #67e8f9;
  --accent-dim: rgba(103, 232, 249, 0.12);
  height: 100%;
  overflow: auto;
  pointer-events: auto;
  background: rgba(8, 10, 22, 0.92);
  border: 1px solid rgba(103, 232, 249, 0.22);
  box-shadow: 0 16px 60px rgba(0, 0, 0, 0.6), 0 0 30px rgba(103, 232, 249, 0.05);
  border-radius: 12px;
  color: #dbe4ff;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
#graph-node-popover.phren-docked .phren-dossier-kind {
  font: 700 10px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #67e8f9;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
#graph-node-popover.phren-docked #graph-node-popover-card { padding: 14px 15px; }
#graph-node-popover.phren-docked .phren-dossier-text {
  white-space: pre-wrap;
  line-height: 1.6;
  font-size: 13px;
  color: #dde6fb;
}
.phren-dossier-section {
  font: 700 9.5px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #67e8f9;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-top: 4px;
}
.phren-dossier-nav {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #8b96c9;
}
.phren-dossier-nav button {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid rgba(103, 232, 249, 0.2);
  background: rgba(12, 15, 30, 0.9);
  color: #9fb2e8;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.phren-dossier-nav button:hover {
  border-color: rgba(103, 232, 249, 0.55);
  color: #e6f6ff;
}
`;
