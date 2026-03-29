import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { build as esbuild } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const cliRoot = path.join(repoRoot, "packages", "cli");
const srcRoot = path.join(cliRoot, "src");
const distRoot = path.join(cliRoot, "dist");
const browserRoot = path.join(cliRoot, "browser");
const tempRoot = path.join(cliRoot, `.dist-build-${process.pid}-${Date.now()}`);

function tscExec() {
  return process.platform === "win32" ? "tsc.cmd" : "tsc";
}

function copySupplementalAssets(targetDir) {
  for (const entry of fs.readdirSync(srcRoot)) {
    if (!/^synonyms.*\.json$/u.test(entry)) continue;
    fs.copyFileSync(path.join(srcRoot, entry), path.join(targetDir, entry));
  }
}

async function bundleBrowserAssets(targetDir) {
  const targetGeneratedDir = path.join(targetDir, "generated");
  fs.mkdirSync(targetGeneratedDir, { recursive: true });
  await esbuild({
    bundle: true,
    entryPoints: [path.join(browserRoot, "memory-ui-graph-app.ts")],
    format: "iife",
    legalComments: "none",
    minify: true,
    outfile: path.join(targetGeneratedDir, "memory-ui-graph.browser.js"),
    platform: "browser",
    target: ["es2020"],
  });
  fs.copyFileSync(
    path.join(targetGeneratedDir, "memory-ui-graph.browser.js"),
    path.join(targetDir, "memory-ui-graph.runtime.js"),
  );
}

function syncTree(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
  pruneMissing(sourceDir, targetDir);
}

function pruneMissing(sourceDir, targetDir) {
  if (!fs.existsSync(targetDir)) return;
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (!fs.existsSync(sourcePath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      continue;
    }

    const sourceStat = fs.statSync(sourcePath);
    const targetStat = fs.statSync(targetPath);
    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      pruneMissing(sourcePath, targetPath);
      continue;
    }
    if (sourceStat.isDirectory() !== targetStat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
    }
  }
}

try {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  await bundleBrowserAssets(tempRoot);
  execFileSync(tscExec(), ["-p", path.join(cliRoot, "tsconfig.json"), "--outDir", tempRoot], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  copySupplementalAssets(tempRoot);
  const entryPath = path.join(tempRoot, "index.js");
  if (fs.existsSync(entryPath)) {
    fs.chmodSync(entryPath, 0o755);
  }
  syncTree(tempRoot, distRoot);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
