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
 * The git checkout this build came from, or null for an installed package.
 *
 * `ROOT` is the package root (packages/cli in a checkout, <prefix>/lib/node_modules/@phren/cli
 * when installed globally). A source checkout has its .git further up — the repo
 * root is the monorepo, not the package — so walk up looking for one instead of
 * testing a fixed number of levels.
 */
function gitCheckoutRoot(): string | null {
  let current = path.resolve(ROOT);
  for (let depth = 0; depth < 5; depth++) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
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

function maybeRefreshStarter(builtEntry: string, refreshStarter: boolean): string {
  if (!refreshStarter) {
    return " Run `phren update --refresh-starter` to refresh global starter assets.";
  }
  run(process.execPath, [builtEntry, "init", "--apply-starter-update", "-y"]);
  // Sweep the store's staging dir, not the package's. Older versions staged
  // `.new`/`.current` pairs there instead of applying the update; now that
  // --apply-starter-update writes the live file (keeping a backup elsewhere),
  // those leftovers are stale and safe to drop.
  const phrenPath = findPhrenPath();
  const cleaned = phrenPath ? cleanupStarterRefreshArtifacts(phrenPath) : 0;
  return cleaned > 0
    ? ` Refreshed starter assets and cleaned ${cleaned} stale staged artifact(s) from an older version.`
    : " Refreshed starter assets.";
}

export async function runPhrenUpdate(opts: RunPhrenUpdateOptions = {}): Promise<UpdateResult> {
  const checkout = gitCheckoutRoot();
  // 0.1.40 moved the entry from mcp/dist/index.js to dist/index.js; resolveEntryScript
  // is the single place that knows where it is.
  const builtEntry = resolveEntryScript();

  if (checkout) {
    try {
      // Warn if working tree is dirty (autostash handles it, but good to know)
      try {
        const status = run("git", ["status", "--porcelain"], checkout);
        if (status) {
          process.stderr.write(`Note: uncommitted changes detected, autostash will preserve them.\n`);
        }
      } catch (err: unknown) {
        logger.debug("runPhrenUpdate gitStatus", errorMessage(err));
      }
      const pull = run("git", ["pull", "--rebase", "--autostash"], checkout);
      run(shellCommand("npm"), ["install"], checkout);
      try {
        run(shellCommand("npm"), ["run", "build"], checkout);
        run(process.execPath, [builtEntry, "--health"], checkout);
      } catch (err: unknown) {
        const detail = errorMessage(err);
        return { ok: false, message: `Local repo updated but rebuild/health check failed: ${detail}` };
      }
      // Outside the rebuild try: a starter-refresh failure must not be reported
      // as a failed update when the pull and rebuild already succeeded.
      const starterMessage = safeRefreshStarter(builtEntry, Boolean(opts.refreshStarter));
      return { ok: true, message: `Updated local phren repo at ${checkout}${pull ? ` (${pull})` : ""}.${starterMessage} Rebuilt and verified CLI health.` };
    } catch (err: unknown) {
      const detail = errorMessage(err);
      return { ok: false, message: `Local repo update failed: ${detail}` };
    }
  }

  try {
    run(shellCommand("npm"), ["install", "-g", `${PACKAGE_NAME}@latest`]);
    run(shellCommand("npm"), ["list", "-g", PACKAGE_NAME, "--depth=0"]);
  } catch (err: unknown) {
    const detail = errorMessage(err);
    return { ok: false, message: `Global update failed: ${detail}. Try manually: npm install -g ${PACKAGE_SPEC}` };
  }
  const starterMessage = safeRefreshStarter(builtEntry, Boolean(opts.refreshStarter));
  return { ok: true, message: `Updated phren via npm global install (@latest) and verified the package is installed.${starterMessage}` };
}

/** Refresh starter assets, reporting a failure inline rather than failing the update. */
function safeRefreshStarter(builtEntry: string, refreshStarter: boolean): string {
  try {
    return maybeRefreshStarter(builtEntry, refreshStarter);
  } catch (err: unknown) {
    logger.debug("runPhrenUpdate refreshStarter", errorMessage(err));
    return ` (starter refresh failed: ${errorMessage(err)} — run \`phren init --apply-starter-update\` manually.)`;
  }
}
