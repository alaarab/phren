import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

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

function storeFile(cwd: string): string {
  const dir = path.join(cwd, ".runtime");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "checkpoints.json");
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

/** Rollback to a checkpoint by discarding current changes and applying the stash. */
export function rollbackToCheckpoint(cwd: string, ref: string): boolean {
  if (!isGitRepo(cwd)) return false;

  try {
    // Discard current working tree changes
    execFileSync("git", ["checkout", "."], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Apply the stash ref
    execFileSync("git", ["stash", "apply", ref], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return true;
  } catch {
    return false;
  }
}

/** List stored checkpoints. */
export function listCheckpoints(cwd: string): Checkpoint[] {
  return loadStore(cwd).checkpoints;
}

/** Get the latest checkpoint ref. */
export function getLatestCheckpoint(cwd: string): string | null {
  const store = loadStore(cwd);
  return store.checkpoints.length > 0
    ? store.checkpoints[store.checkpoints.length - 1].ref
    : null;
}
