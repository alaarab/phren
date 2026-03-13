import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "mcp", "dist");
const entryPath = path.join(distDir, "index.js");
const synonymsSource = path.join(root, "mcp", "src", "synonyms.json");
const synonymsTarget = path.join(distDir, "synonyms.json");
const tscCli = path.join(root, "node_modules", "typescript", "bin", "tsc");

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

fs.rmSync(distDir, { recursive: true, force: true });
runNodeScript(tscCli, ["-p", path.join(root, "mcp", "tsconfig.json")]);
fs.chmodSync(entryPath, 0o755);
fs.copyFileSync(synonymsSource, synonymsTarget);
