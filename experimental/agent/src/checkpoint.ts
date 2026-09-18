import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface Checkpoint {
  ref: string;
  label: string;
  createdAt: string;
}

export interface CheckpointStore {
  checkpoints: Checkpoint[];
}

function isGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function repoKey(cwd: string): string {
  let root = cwd;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim() || cwd;
  } catch { /* not a repo yet; fall back to cwd */ }
  try { root = fs.realpathSync(root); } catch { /* keep the path as given */ }
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

function storeFile(cwd: string): string {
  const dir = path.join(os.homedir(), ".phren-agent", "checkpoints");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${repoKey(cwd)}.json`);
  const legacy = path.join(os.homedir(), ".phren-agent", "checkpoints.json");
  if (!fs.existsSync(file) && fs.existsSync(legacy)) {
    try { fs.renameSync(legacy, file); } catch { /* best effort migration */ }
  }
  return file;
}

function loadStore(cwd: string): CheckpointStore {
  const file = storeFile(cwd);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch { /* ignore corrupt */ }
  }
  return { checkpoints: [] };
}

function saveStore(cwd: string, store: CheckpointStore): void {
  fs.writeFileSync(storeFile(cwd), JSON.stringify(store, null, 2) + "\n");
}

/**
 * Create a checkpoint via `git stash create`. Returns the ref or null if
 * the working tree is clean (stash create produces no output when clean).
 */
export function createCheckpoint(cwd: string, label?: string): string | null {
  if (!isGitRepo(cwd)) return null;

  try {
    const ref = execFileSync("git", ["stash", "create"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    if (!ref) return null; // clean working tree

    // Store the ref so `git gc` won't collect it
    execFileSync("git", ["stash", "store", "-m", label || "phren-checkpoint", ref], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const store = loadStore(cwd);
    store.checkpoints.push({
      ref,
      label: label || `checkpoint-${store.checkpoints.length + 1}`,
      createdAt: new Date().toISOString(),
    });
    saveStore(cwd, store);
    return ref;
  } catch {
    return null;
  }
}

/** Stored checkpoints, newest first. */
export function listCheckpoints(): Checkpoint[] {
  return loadStore(process.cwd()).checkpoints.slice().reverse();
}

/**
 * Restore the working tree to a stored checkpoint. Takes a safety checkpoint
 * of the current state first, then discards tracked changes and applies the
 * checkpoint's stash ref.
 */
export function restoreCheckpoint(cwd: string, ref: string): { ok: boolean; message: string } {
  if (!isGitRepo(cwd)) return { ok: false, message: "Not a git repository." };
  const checkpoint = loadStore(cwd).checkpoints.find((c) => c.ref === ref || c.label === ref);
  if (!checkpoint) return { ok: false, message: `No checkpoint "${ref}".` };
  try {
    createCheckpoint(cwd, "pre-restore");
    execFileSync("git", ["checkout", "--", "."], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["stash", "apply", checkpoint.ref], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, message: `Restored ${checkpoint.label} (${checkpoint.createdAt.slice(0, 19).replace("T", " ")}).` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

