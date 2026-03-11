import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { errorMessage } from "./utils.js";
import { PACKAGE_NAME, PACKAGE_SPEC } from "./package-metadata.js";

function shellCommand(bin: "npm" | "npx"): string {
  return process.platform === "win32" ? `${bin}.cmd` : bin;
}

function packageRootFromRuntime(): string {
  const current = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(current), "..", "..");
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && cmd.endsWith(".cmd"),
    timeout: 180_000,
  }).trim();
}

export interface UpdateResult {
  ok: boolean;
  message: string;
}

interface RunCortexUpdateOptions {
  refreshStarter?: boolean;
}

function cleanupStarterRefreshArtifacts(cortexPath: string): number {
  const runtimeRoot = path.join(cortexPath, ".runtime", "starter-updates");
  if (!fs.existsSync(runtimeRoot)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(runtimeRoot, { recursive: true })) {
    const fullPath = path.join(runtimeRoot, String(entry));
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;
    if (fullPath.endsWith(".new") || fullPath.endsWith(".current")) {
      fs.unlinkSync(fullPath);
      removed++;
    }
  }
  return removed;
}

function maybeRefreshStarter(root: string, builtEntry: string, refreshStarter: boolean): string {
  if (!refreshStarter) {
    return " Run `cortex update --refresh-starter` to refresh global starter assets.";
  }
  run(process.execPath, [builtEntry, "init", "--apply-starter-update", "-y"], root);
  const cleaned = cleanupStarterRefreshArtifacts(root);
  return cleaned > 0
    ? ` Refreshed starter assets and cleaned ${cleaned} staged starter artifact(s).`
    : " Refreshed starter assets.";
}

export async function runCortexUpdate(opts: RunCortexUpdateOptions = {}): Promise<UpdateResult> {
  const root = packageRootFromRuntime();
  const hasGit = fs.existsSync(path.join(root, ".git"));
  const builtEntry = path.join(root, "mcp", "dist", "index.js");

  if (hasGit) {
    try {
      // Warn if working tree is dirty (autostash handles it, but good to know)
      try {
        const status = run("git", ["status", "--porcelain"], root);
        if (status) {
          process.stderr.write(`Note: uncommitted changes detected, autostash will preserve them.\n`);
        }
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] runCortexUpdate gitStatus: ${errorMessage(err)}\n`);
      }
      const pull = run("git", ["pull", "--rebase", "--autostash"], root);
      run(shellCommand("npm"), ["install"], root);
      try {
        run(shellCommand("npm"), ["run", "build"], root);
        run(process.execPath, [builtEntry, "--health"], root);
        const starterMessage = maybeRefreshStarter(root, builtEntry, Boolean(opts.refreshStarter));
        return { ok: true, message: `Updated local cortex repo at ${root}${pull ? ` (${pull})` : ""}.${starterMessage} Rebuilt and verified CLI health.` };
      } catch (err: unknown) {
        const detail = errorMessage(err);
        return { ok: false, message: `Local repo updated but rebuild/health check failed: ${detail}` };
      }
    } catch (err: unknown) {
      const detail = errorMessage(err);
      return { ok: false, message: `Local repo update failed: ${detail}` };
    }
  }

  try {
    run(shellCommand("npm"), ["install", "-g", `${PACKAGE_NAME}@latest`]);
    run(shellCommand("npm"), ["list", "-g", PACKAGE_NAME, "--depth=0"]);
    const starterMessage = maybeRefreshStarter(root, builtEntry, Boolean(opts.refreshStarter));
    return { ok: true, message: `Updated cortex via npm global install (@latest) and verified the package is installed.${starterMessage}` };
  } catch (err: unknown) {
    const detail = errorMessage(err);
    return { ok: false, message: `Global update failed: ${detail}. Try manually: npm install -g ${PACKAGE_SPEC}` };
  }
}
