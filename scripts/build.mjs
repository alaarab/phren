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

// Windows CI intermittently throws EBUSY/EPERM/ENOTEMPTY on rm/cp of the dist
// tree when an antivirus scanner or a lingering file handle briefly locks a
// freshly written file. These operations are idempotent, so a short retry with
// backoff absorbs the transient lock instead of failing the whole build.
const TRANSIENT_FS_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES", "EEXIST"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFsRetry(fn, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt >= attempts || !TRANSIENT_FS_CODES.has(err?.code)) throw err;
      sleepSync(attempt * 100);
    }
  }
}

function rmDir(target) {
  withFsRetry(() => fs.rmSync(target, { recursive: true, force: true }));
}

function cpAny(source, target) {
  withFsRetry(() => fs.cpSync(source, target, { recursive: true, force: true }));
}

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
  cpAny(sourceDir, targetDir);
  pruneMissing(sourceDir, targetDir);
}

function pruneMissing(sourceDir, targetDir) {
  if (!fs.existsSync(targetDir)) return;
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (!fs.existsSync(sourcePath)) {
      rmDir(targetPath);
      continue;
    }

    const sourceStat = fs.statSync(sourcePath);
    const targetStat = fs.statSync(targetPath);
    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      pruneMissing(sourcePath, targetPath);
      continue;
    }
    if (sourceStat.isDirectory() !== targetStat.isDirectory()) {
      rmDir(targetPath);
      cpAny(sourcePath, targetPath);
    }
  }
}

try {
  rmDir(tempRoot);
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
  rmDir(tempRoot);
}
