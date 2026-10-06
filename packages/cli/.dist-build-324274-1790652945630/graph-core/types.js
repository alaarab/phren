/**
 * Shared graph payload contract.
 *
 * This module is consumed by three hosts: the browser 3D viewer (bundled by
 * esbuild from `browser/`), the VS Code webview (via the same bundle), and the
 * terminal graph view in `phren shell` (compiled by tsc). It must therefore
 * stay free of DOM, node builtins, and any import outside `src/graph-core/`.
 */
// ── Holographic-archive palette ─────────────────────────────────────────
/** The void. Every layer sits on this near-black indigo. */
export const BG_COLOR = "#05060f";
/** Amber used for selection / focused links — the single warm accent. */
export const ACCENT_AMBER = "#ffd166";
/** Cyan used for live pulses, HUD borders and hover accents. */
export const ACCENT_CYAN = "#67e8f9";
export const TOPIC_COLORS = {
    architecture: "#46c8ff",
    debugging: "#ff5470",
    security: "#ff7847",
    performance: "#ffb648",
    testing: "#3ce8a4",
    devops: "#2ee6c8",
    tooling: "#6d8dff",
    api: "#4f7dff",
    database: "#38b6ff",
    frontend: "#b48bff",
    auth: "#ff9346",
    data: "#2ed3e8",
    mobile: "#43e0a8",
    ai_ml: "#9d7bff",
    general: "#7f8db3",
};
export const KIND_COLORS = {
    project: "#f5b342",
    entity: "#38e1ff",
    reference: "#42e099",
    note: "#c9a67a",
    "task-active": "#3ae374",
    "task-queue": "#48b2ff",
    "task-done": "#5c6b8a",
    other: "#7f8db3",
};
// Distinct colors per store — up to 6 stores, then cycles
export const STORE_COLORS = ["#f5b342", "#9d7bff", "#2ed3e8", "#ff5470", "#43e0a8", "#f472b6"];
