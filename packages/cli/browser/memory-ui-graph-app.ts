// Phren knowledge-graph renderer — "holographic archive".
//
// This file is the esbuild entry (see scripts/build.mjs). The renderer is
// decomposed into ./graph/* modules; importing the API module installs
// window.phrenGraph plus the graphZoom/graphReset/graphResetLayout/
// graphClearSelection globals as a side effect. Hosts (web memory UI and
// the VS Code webview) inline the built IIFE bundle and then call
// window.phrenGraph.mount(payload).
import "./graph/api.js";
