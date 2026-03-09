import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { errorMessage } from "./utils.js";

function packageRootFromRuntime(): string {
  const current = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(current), "..", "..");
}

function readPackageName(packageRoot: string): string | null {
  const packageJson = path.join(packageRoot, "package.json");
  if (!fs.existsSync(packageJson)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { name?: string };
    return parsed.name || null;
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readPackageName: ${errorMessage(err)}\n`);
    return null;
  }
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  }).trim();
}

export interface UpdateResult {
  ok: boolean;
  message: string;
}

export async function runCortexUpdate(): Promise<UpdateResult> {
  const root = packageRootFromRuntime();
  const pkgName = readPackageName(root);
  const hasGit = fs.existsSync(path.join(root, ".git"));
  const builtEntry = path.join(root, "mcp", "dist", "index.js");

  if (pkgName === "@alaarab/cortex" && hasGit) {
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
      run("npm", ["install"], root);
      try {
        run("npm", ["run", "build"], root);
        run(process.execPath, [builtEntry, "--health"], root);
      } catch (err: unknown) {
        const detail = errorMessage(err);
        return { ok: false, message: `Local repo updated but rebuild/health check failed: ${detail}` };
      }
      return { ok: true, message: `Updated local cortex repo at ${root}${pull ? ` (${pull})` : ""}. Rebuilt and verified CLI health.` };
    } catch (err: unknown) {
      const detail = errorMessage(err);
      return { ok: false, message: `Local repo update failed: ${detail}` };
    }
  }

  try {
    run("npm", ["install", "-g", "@alaarab/cortex@latest"]);
    run("npm", ["list", "-g", "@alaarab/cortex", "--depth=0"]);
    return { ok: true, message: "Updated cortex via npm global install (@latest) and verified the package is installed." };
  } catch (err: unknown) {
    const detail = errorMessage(err);
    return { ok: false, message: `Global update failed: ${detail}. Try manually: npm install -g @alaarab/cortex@latest` };
  }
}
