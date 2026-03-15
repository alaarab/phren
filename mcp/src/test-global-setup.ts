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
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(REPO_ROOT, "mcp", "dist", "index.js");

export async function setup(): Promise<void> {
  if (fs.existsSync(CLI_PATH)) {
    // Dist already present — skip build. This is the common path when
    // `npm test` is used (pretest already built it) or during watch mode
    // re-runs where the artifact is still fresh.
    return;
  }

  process.stdout.write("[test-global-setup] mcp/dist missing — building...\n");
  execFileSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: 60_000,
  });
  process.stdout.write("[test-global-setup] build complete.\n");
}
