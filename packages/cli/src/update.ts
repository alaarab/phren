import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { errorMessage } from "./utils.js";
import { PACKAGE_NAME, PACKAGE_SPEC, ROOT } from "./package-metadata.js";
import { resolveEntryScript } from "./init/shared.js";
import { findPhrenPath } from "./shared.js";
import { logger } from "./logger.js";

function shellCommand(bin: "npm" | "npx"): string {
  return process.platform === "win32" ? `${bin}.cmd` : bin;
}

/**
 * The source checkout this build runs from, or null for an installed package.
 * The package root is packages/cli, so the monorepo root is two levels above it.
 * An installed package (under node_modules) is never treated as a checkout, even
 * if some directory above it happens to be a git repo.
 */
function sourceCheckoutRoot(): string | null {
  if (ROOT.split(path.sep).includes("node_modules")) return null;
  const repoRoot = path.resolve(ROOT, "..", "..");
  return fs.existsSync(path.join(repoRoot, ".git")) ? repoRoot : null;
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

interface UpdateResult {
  ok: boolean;
  message: string;
}

interface RunPhrenUpdateOptions {
  refreshStarter?: boolean;
}

function cleanupStarterRefreshArtifacts(phrenPath: string): number {
  const runtimeRoot = path.join(phrenPath, ".runtime", "starter-updates");
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
    return " Run `phren update --refresh-starter` to refresh global starter assets.";
  }
  run(process.execPath, [builtEntry, "init", "--apply-starter-update", "-y"], root);
  // The staged starter files live in the store, not the package.
  const phrenPath = findPhrenPath();
  const cleaned = phrenPath ? cleanupStarterRefreshArtifacts(phrenPath) : 0;
  return cleaned > 0
    ? ` Refreshed starter assets and cleaned ${cleaned} staged starter artifact(s).`
    : " Refreshed starter assets.";
}

export async function runPhrenUpdate(opts: RunPhrenUpdateOptions = {}): Promise<UpdateResult> {
  const checkout = sourceCheckoutRoot();
  const root = checkout ?? ROOT;
  const builtEntry = resolveEntryScript();

  if (checkout) {
    try {
      // Warn if working tree is dirty (autostash handles it, but good to know)
      try {
        const status = run("git", ["status", "--porcelain"], root);
        if (status) {
          process.stderr.write(`Note: uncommitted changes detected, autostash will preserve them.\n`);
        }
      } catch (err: unknown) {
        logger.debug("runPhrenUpdate gitStatus", errorMessage(err));
      }
      const pull = run("git", ["pull", "--ff-only", "--autostash"], root);
      run(shellCommand("npm"), ["install"], root);
      try {
        run(shellCommand("npm"), ["run", "build"], root);
        run(process.execPath, [builtEntry, "--health"], root);
        const starterMessage = maybeRefreshStarter(root, builtEntry, Boolean(opts.refreshStarter));
        return { ok: true, message: `Updated local phren repo at ${root}${pull ? ` (${pull})` : ""}.${starterMessage} Rebuilt and verified CLI health.` };
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
    return { ok: true, message: `Updated phren via npm global install (@latest) and verified the package is installed.${starterMessage}` };
  } catch (err: unknown) {
    const detail = errorMessage(err);
    return { ok: false, message: `Global update failed: ${detail}. Try manually: npm install -g ${PACKAGE_SPEC}` };
  }
}
