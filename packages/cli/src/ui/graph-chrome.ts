// Holographic chrome for the Graph tab. Appended LAST in the page <style>
// block so it wins the cascade over the base styles. The graph canvas is
// immersive-dark in BOTH app themes (the 3D scene is always a dark void —
// a light chrome ring around it read as unfinished).
export const GRAPH_HUD_STYLES = `
/* ── Full-bleed graph tab ─────────────────────────────────────────── */
body:has(#tab-graph.active) .main { max-width: none; padding: 0; }
#tab-graph .graph-container {
  background: #05060f;
  border: none;
  border-radius: 0;
  position: relative;
  overflow: hidden;
}
#tab-graph #graph-canvas {
  height: calc(100vh - 64px);
  min-height: 520px;
}

/* ── Overlay chrome ───────────────────────────────────────────────── */
#tab-graph .graph-filters {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  right: 60px;
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

/* ── Docked dossier panel ─────────────────────────────────────────── */
#graph-node-popover.phren-docked {
  left: auto !important;
  right: 60px !important;
  top: 68px !important;
  bottom: 16px;
  width: 420px;
  max-width: min(440px, calc(100% - 32px));
  pointer-events: none;
  z-index: 12;
}
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
#graph-node-popover.phren-docked .phren-dossier-text {
  white-space: pre-wrap;
  line-height: 1.7;
  font-size: 14px;
  color: #e8edff;
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
