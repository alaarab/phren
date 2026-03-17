import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function graphAssetCandidates(): string[] {
  return [
    path.join(__dirname, "generated", "memory-ui-graph.browser.js"),
    path.join(__dirname, "memory-ui-graph.runtime.js"),
    path.join(process.cwd(), "mcp", "dist", "generated", "memory-ui-graph.browser.js"),
    path.join(process.cwd(), "mcp", "dist", "memory-ui-graph.runtime.js"),
  ];
}

export function renderGraphScript(): string {
  for (const candidate of graphAssetCandidates()) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
    } catch {
      // Keep trying fallbacks.
    }
  }

  return `
(function() {
  console.error('[phrenGraph] Bundled Sigma asset not found. Run "npm run build" in the phren repo root.');
  window.phrenGraph = window.phrenGraph || {
    __renderer: 'missing',
    mount: function() {},
    onNodeSelect: function() {},
    onSelectionClear: function() {},
    clearSelection: function() {},
    selectNode: function() { return false; },
    getNodeAt: function() { return null; },
    getNodeDetail: function() { return null; },
    destroy: function() {}
  };
  window.graphZoom = window.graphZoom || function() {};
  window.graphReset = window.graphReset || function() {};
  window.graphClearSelection = window.graphClearSelection || function() {};
})();
`;
}
