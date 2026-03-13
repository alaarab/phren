import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

function npmExec() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pack-check-"));
const capturePath = path.join(captureDir, "pack.json");
const captureFd = fs.openSync(capturePath, "w");

const result = spawnSync(npmExec(), ["pack", "--json", "--dry-run"], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
  stdio: ["ignore", captureFd, "pipe"],
});

fs.closeSync(captureFd);

let packInfo;
try {
  if (result.error) {
    fail(result.error.message);
  }

  if (result.status !== 0) {
    fail(result.stderr || "npm pack --dry-run failed");
  }

  packInfo = JSON.parse(fs.readFileSync(capturePath, "utf8"));
} catch (error) {
  fail(`Failed to parse npm pack output: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  fs.rmSync(captureDir, { recursive: true, force: true });
}

const files = new Set((packInfo?.[0]?.files ?? []).map((file) => file.path));
for (const requiredFile of ["package.json", "mcp/dist/index.js", "mcp/dist/tool-registry.js", "icon.svg"]) {
  if (!files.has(requiredFile)) {
    fail(`Pack verification failed: missing ${requiredFile}`);
  }
}

if (files.has("mcp/src/index.ts")) {
  fail("Pack verification failed: source TypeScript unexpectedly shipped");
}

process.stdout.write("Pack verification passed.\n");
