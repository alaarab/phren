// Local harness: bundle graphWebview.ts (stubbing the `vscode` module), render
// the REAL webview HTML with a synthetic payload, relax CSP + stub
// acquireVsCodeApi so it runs in a plain browser, and write it to disk.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outCjs = path.join(__dirname, "gwv.bundle.cjs");
const outHtml = path.join(__dirname, "vscode-webview.html");

const stubVscode = {
  name: "stub-vscode",
  setup(b) {
    b.onResolve({ filter: /^vscode$/ }, (a) => ({ path: a.path, namespace: "stub-vscode" }));
    b.onLoad({ filter: /.*/, namespace: "stub-vscode" }, () => ({
      contents: "module.exports = new Proxy({}, { get: () => function(){} });",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: [path.join(__dirname, "..", "src", "graphWebview.ts")],
  outfile: outCjs,
  bundle: true,
  platform: "node",
  format: "cjs",
  plugins: [stubVscode],
  logLevel: "error",
});

const require = createRequire(import.meta.url);
const { renderGraphHtmlForTests } = require(outCjs);

// Synthetic vscode GraphPayload (extension node shape).
const topics = [["architecture", "Architecture"], ["debugging", "Debugging"], ["security", "Security"], ["performance", "Performance"], ["testing", "Testing"], ["api", "API"]];
const nodes = [];
const edges = [];
const entries = {};
const ages = [4, 20, 80, 120, 220, 320];
let k = 0;
for (const proj of ["api-server", "web-app"]) {
  nodes.push({ id: "project:" + proj, kind: "project", projectName: proj, label: proj, text: proj + " summary", subtype: "project", radius: 20, color: "#7B68AE" });
  for (let i = 0; i < 12; i++) {
    const [slug, tlabel] = topics[i % topics.length];
    const id = "finding:" + proj + ":" + i;
    const key = "sk" + (k++);
    const age = ages[i % ages.length];
    entries[key] = { impressions: i, helpful: i % 4, repromptPenalty: 0, regressionPenalty: 0, lastUsedAt: new Date(Date.now() - age * 86400000).toISOString() };
    nodes.push({ id, kind: "finding", projectName: proj, label: tlabel + " finding " + (i + 1), text: tlabel + " finding " + (i + 1) + " for " + proj + " — a representative memory describing a pattern or pitfall.", subtype: slug, topicSlug: slug, topicLabel: tlabel, scoreKey: key, date: "2026-0" + (1 + (i % 6)) + "-1" + (i % 9), radius: 8, color: "#5B4B8A" });
    edges.push({ source: "project:" + proj, target: id });
  }
  for (let t = 0; t < 4; t++) {
    const section = t % 3 === 0 ? "Active" : t % 3 === 1 ? "Queue" : "Done";
    const id = "task:" + proj + ":" + t;
    nodes.push({ id, kind: "task", projectName: proj, label: "Task " + (t + 1) + " for " + proj, text: "Task " + (t + 1) + " for " + proj, subtype: section.toLowerCase(), section, priority: t % 2 ? "high" : "", radius: 7, color: "#00E5FF" });
    edges.push({ source: "project:" + proj, target: id });
  }
}
const payload = { nodes, edges, summaries: {}, scores: { schemaVersion: 1, entries }, topics: topics.map(([slug, label]) => ({ slug, label })) };

let html = renderGraphHtmlForTests(payload);
// Relax CSP + stub the VS Code API so the inline scripts run in a plain browser.
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
html = html.replace(
  "<body>",
  "<body>\n<script>window.acquireVsCodeApi=function(){return {postMessage:function(){},getState:function(){return {}},setState:function(){}}};</script>",
);
fs.writeFileSync(outHtml, html);
console.log("WROTE " + outHtml + " (" + html.length + " bytes)");
