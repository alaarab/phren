import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface Checkpoint {
  ref: string;
  label: string;
  createdAt: string;
  /** Snapshot mechanism. Absent on legacy entries, which are stash refs. */
  kind?: "stash" | "commit";
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

function repoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim() || cwd;
  } catch {
    return cwd;
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
 * Create a checkpoint of the working tree, untracked files included.
 *
 * `git stash create` ignores untracked files, so a file created by write_file
 * could not be captured or removed by /rewind. Instead, stage the tree into a
 * throwaway index (GIT_INDEX_FILE) seeded from HEAD, write it to a tree object,
 * wrap it in a commit, and pin it with an update-ref so `git gc` keeps it. The
 * store keeps the commit SHA; `kind: "commit"` marks the new scheme, while
 * entries written before this change have no `kind` and are restored as stash
 * refs. Returns the commit ref, or null when the snapshot could not be made.
 */
export function createCheckpoint(cwd: string, label?: string): string | null {
  if (!isGitRepo(cwd)) return null;

  const root = repoRoot(cwd);
  const indexFile = path.join(os.tmpdir(), `phren-agent-index-${randomUUID()}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "phren-agent",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "agent@phren.local",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "phren-agent",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "agent@phren.local",
  };

  try {
    execFileSync("git", ["read-tree", "HEAD"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["add", "-A"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const tree = execFileSync("git", ["write-tree"], { cwd: root, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!tree) return null;

    const commit = execFileSync(
      "git",
      ["commit-tree", tree, "-p", "HEAD", "-m", label || "phren-checkpoint"],
      { cwd: root, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!commit) return null;

    const refName = `refs/phren-agent/checkpoints/${repoKey(root)}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    execFileSync("git", ["update-ref", refName, commit], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

    const store = loadStore(root);
    store.checkpoints.push({
      ref: commit,
      label: label || `checkpoint-${store.checkpoints.length + 1}`,
      createdAt: new Date().toISOString(),
      kind: "commit",
    });
    saveStore(root, store);
    return commit;
  } catch {
    return null;
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

/** Stored checkpoints, newest first. */
export function listCheckpoints(): Checkpoint[] {
  return loadStore(process.cwd()).checkpoints.slice().reverse();
}

/**
 * Restore the working tree to a stored checkpoint. Takes a safety checkpoint
 * of the current state first. New "commit" checkpoints restore the full tree
 * (`git checkout <ref> -- .`) and remove untracked files created since
 * (`git clean -fd`, which leaves ignored files alone). Legacy stash refs keep
 * the old checkout + stash-apply path.
 */
export function restoreCheckpoint(cwd: string, ref: string): { ok: boolean; message: string } {
  if (!isGitRepo(cwd)) return { ok: false, message: "Not a git repository." };
  const root = repoRoot(cwd);
  const checkpoint = loadStore(root).checkpoints.find((c) => c.ref === ref || c.label === ref);
  if (!checkpoint) return { ok: false, message: `No checkpoint "${ref}".` };
  try {
    createCheckpoint(root, "pre-restore");
    if (checkpoint.kind === "commit") {
      execFileSync("git", ["checkout", checkpoint.ref, "--", "."], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("git", ["clean", "-fd"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      execFileSync("git", ["checkout", "--", "."], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("git", ["stash", "apply", checkpoint.ref], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    }
    return { ok: true, message: `Restored ${checkpoint.label} (${checkpoint.createdAt.slice(0, 19).replace("T", " ")}).` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

