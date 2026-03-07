import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CortexResult } from "./shared.js";

/**
 * Create a temp directory and return its path + cleanup function.
 */
export function makeTempDir(prefix: string): { path: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // On Windows, SQLite WAL files or antivirus scans can briefly lock files
        // after a process exits, causing ENOTEMPTY/EBUSY. Safe to ignore for temp dirs.
      }
    },
  };
}

/**
 * Write governance access-control.json granting admin to the given actor,
 * and set CORTEX_ACTOR in process.env. Returns the actor name.
 */
export function grantAdmin(cortexDir: string, actor = "vitest-admin"): string {
  const govDir = path.join(cortexDir, ".governance");
  fs.mkdirSync(govDir, { recursive: true });
  fs.writeFileSync(
    path.join(govDir, "access-control.json"),
    JSON.stringify({
      admins: [actor],
      maintainers: [],
      contributors: [],
      viewers: [],
    }, null, 2) + "\n"
  );
  process.env.CORTEX_ACTOR = actor;
  return actor;
}

/**
 * Recursively create parent dirs and write a file.
 */
export function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/**
 * Extract the user-facing message from a CortexResult<string>.
 */
export function resultMsg(r: CortexResult<string>): string {
  return r.ok ? r.data : r.error;
}
