/**
 * What the model has seen of each file, so the write tools can refuse to work
 * from a stale picture.
 *
 * read_file records a file's state; a successful edit, write or patch records
 * the state it left behind. Before writing, the tools check the file on disk
 * against that record:
 *
 * - changed since the model last saw it (the user, a formatter or a shell
 *   command touched it): refused, so a whole-file write can't silently drop
 *   the other change and an edit is not planned against old text;
 * - an existing file the model never read: write_file refuses to overwrite
 *   it. Edits and patch hunks are allowed, because their old text has to
 *   match the file exactly, which already grounds them in its contents.
 *
 * One record per process, which is one session: subagents are separate
 * processes with their own records, so a child that changes a file the
 * parent has read makes the parent read it again.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

interface FileRecord {
  mtimeMs: number;
  size: number;
  hash: string;
}

const records = new Map<string, FileRecord>();

function key(filePath: string): string {
  const abs = path.resolve(filePath);
  try { return fs.realpathSync(abs); } catch { return abs; }
}

function hashOf(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Remember the file as it is on disk now (after a read or a write). */
export function recordFileState(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return;
    records.set(key(filePath), { mtimeMs: stat.mtimeMs, size: stat.size, hash: hashOf(fs.readFileSync(filePath)) });
  } catch {
    records.delete(key(filePath));
  }
}

/** Forget a file the tools deleted. */
export function forgetFileState(filePath: string): void {
  records.delete(key(filePath));
}

/**
 * Why the file must not be written now, or null when it may be. `requireRead`
 * is for whole-file overwrites.
 */
export function staleFileError(filePath: string, opts: { requireRead?: boolean } = {}): string | null {
  if (process.env.PHREN_AGENT_FILE_GUARD === "off") return null;
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile()) return null;
  const k = key(filePath);
  const seen = records.get(k);
  if (!seen) {
    return opts.requireRead
      ? `${filePath} already exists and has not been read in this session. Read it with read_file first; to change part of it, use edit_file.`
      : null;
  }
  if (stat.mtimeMs === seen.mtimeMs && stat.size === seen.size) return null;
  // Touched but maybe not changed (a formatter that found nothing to do).
  const hash = hashOf(fs.readFileSync(filePath));
  if (hash === seen.hash) {
    records.set(k, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
    return null;
  }
  return `${filePath} changed on disk since you last read or wrote it (by the user, a formatter or a command). Read it again with read_file before changing it; nothing was written.`;
}

/** Test seam: forget everything. */
export function resetFileState(): void {
  records.clear();
}
