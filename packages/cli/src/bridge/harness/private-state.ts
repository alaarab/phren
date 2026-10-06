import { lstat, mkdir, readFile, rmdir } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "../protocol.js";

export async function readPrivateState(file: string, limit = 65536): Promise<string | undefined> {
  const info = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit || (info.mode & 0o077) || process.getuid && info.uid !== process.getuid()) throw new BridgeError(409, "Expected a private owner state file.");
  return readFile(file, "utf8");
}

/** A stale lock never authorizes takeover. The owner must resolve an interrupted write. */
export async function lockedState<T>(file: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + ".lock";
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new BridgeError(409, "Owner state is locked; an interrupted operation requires explicit owner repair."); }
  try { return await operation(); } finally { await rmdir(lock); }
}
