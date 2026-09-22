#!/usr/bin/env node
// Bundles the shared 3D graph renderer into the iOS app's resources.
//
// The renderer in packages/cli/browser/graph/* is the same code the web memory
// UI and the VS Code webview run; this produces the same IIFE for the app's
// WKWebView, so the phone renders from one implementation rather than a
// transcription. Mirrors bundleBrowserAssets() in scripts/build.mjs.
//
// Run from apps/ios after changing anything under packages/cli/browser/:
//   node scripts/bundle-graph.mjs
//
// The output is gitignored , regenerate it rather than committing 2 MB of
// minified JS, exactly as PhrenKit's fixtures are regenerated.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const iosRoot = path.resolve(here, "..");
const repoRoot = path.resolve(iosRoot, "../..");
const browserRoot = path.join(repoRoot, "packages/cli/browser");
const outDir = path.join(iosRoot, "Phren/Resources/graph");

const entry = path.join(browserRoot, "memory-ui-graph-app.ts");
if (!fs.existsSync(entry)) {
  console.error(`Renderer entry not found: ${entry}`);
  process.exit(1);
}

// The app uses WebGL and its postprocessing composer. three-render-objects
// also imports an optional WebGPU backend, which would otherwise be retained.
export async function bundleGraph(write = true) {
  if (write) fs.mkdirSync(outDir, { recursive: true });
  return build({
    bundle: true,
    entryPoints: [entry],
    format: "iife",
    legalComments: "none",
    minify: true,
    outfile: path.join(outDir, "phren-graph.js"),
    platform: "browser",
    target: ["safari17"],
    alias: { "three/webgpu": path.join(browserRoot, "graph/webgl-only.ts") },
    metafile: true,
    write,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await bundleGraph();
  const bytes = fs.statSync(path.join(outDir, "phren-graph.js")).size;
  console.log(`Wrote Phren/Resources/graph/phren-graph.js (${bytes} bytes)`);
}
