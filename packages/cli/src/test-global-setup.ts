/**
 * Vitest globalSetup — runs once in the main process before any test workers spawn.
 *
 * Builds mcp/dist if it is missing so every fork sees a complete, consistent
 * dist artifact before tests begin. Individual subprocess helpers can still
 * repair a missing artifact later under a lock if some test mutates dist.
 *
 * `pretest` in package.json already calls `npm run build`, so in normal `npm test`
 * runs this is a fast no-op check. It is the safety net for:
 *   - `vitest run` called directly (no pretest hook)
 *   - Watch mode re-runs where pretest does not re-fire
 *   - CI environments that skip npm lifecycle scripts
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI_PATH = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");

let sandboxHome: string | null = null;

/**
 * Point HOME (and USERPROFILE) at a throwaway directory for the whole run.
 *
 * `pool: "forks"` workers inherit this process's env, and on Linux/macOS
 * `os.homedir()` reads $HOME too, so this covers every route the CLI uses to
 * find the user's home. Without it, isolation depends on each test
 * remembering to override HOME — and the ones that forgot (e.g. the web-ui
 * readiness test) re-pointed the developer's real ~/.claude/CLAUDE.md and
 * ~/.claude/skills/phren-* at temp dirs that were deleted seconds later.
 */
function sandboxHomeDir(): void {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "phren-test-home-"));
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
}

export async function teardown(): Promise<void> {
  if (sandboxHome) fs.rmSync(sandboxHome, { recursive: true, force: true });
}

export async function setup(): Promise<void> {
  sandboxHomeDir();
  if (fs.existsSync(CLI_PATH)) {
    // Dist already present — skip build. This is the common path when
    // `npm test` is used (pretest already built it) or during watch mode
    // re-runs where the artifact is still fresh.
    return;
  }

  process.stdout.write("[test-global-setup] packages/cli/dist missing — building...\n");
  execFileSync("pnpm", ["build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: 60_000,
  });
  process.stdout.write("[test-global-setup] build complete.\n");
}
