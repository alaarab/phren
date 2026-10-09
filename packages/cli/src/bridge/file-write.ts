import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileVersion, MAX_FILE_RANGE } from "./file-range.js";
import { BridgeError } from "./protocol.js";

/**
 * Write one text file inside a repository root the server chose (a pane's
 * checkout), for the desktop editor. The same path rules as reads: relative,
 * no `..`, no `.git`, no symbolic link anywhere on the way, no control
 * characters. An update must name the version the editor read
 * (`fileVersion`) and fails with 409 `file-changed` when the file moved since;
 * leaving the version out creates a new file and fails with `file-exists`
 * when one is there. Updates go through a temp file in the same folder and a
 * rename, keeping the file's mode, so a reader never sees half a file.
 */
export async function writeRepoFile(root: string, requested: string, content: string, expectedVersion?: string) {
  if (typeof requested !== "string" || !requested || requested.length > 4096 || path.isAbsolute(requested)
      || /[\x00-\x1f\x7f\\]/.test(requested) || requested.split("/").some(part => part === ".." || part === ".git" || part === "")) {
    throw new BridgeError(400, "Invalid file path.");
  }
  if (typeof content !== "string") throw new BridgeError(400, "Supply the file's text.");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_FILE_RANGE) throw new BridgeError(413, "Files over 4 MiB cannot be saved from here.");
  if (expectedVersion !== undefined && (typeof expectedVersion !== "string" || expectedVersion.length > 200)) throw new BridgeError(400, "Invalid file version.");

  const base = await realpath(root);
  const parts = requested.split("/");
  let directory = base;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    const info = await lstat(directory).catch(() => undefined);
    if (!info) throw new BridgeError(404, "That folder does not exist.");
    if (info.isSymbolicLink()) throw new BridgeError(403, "Symbolic links cannot be written through.");
    if (!info.isDirectory()) throw new BridgeError(400, "That folder is not a directory.");
  }
  if ((await realpath(directory)) !== directory) throw new BridgeError(403, "This file is outside the repository.");
  const file = path.join(directory, parts[parts.length - 1]);
  if (file !== base && !file.startsWith(base + path.sep)) throw new BridgeError(403, "This file is outside the repository.");

  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new BridgeError(403, "Symbolic links cannot be written through.");
  if (existing && !existing.isFile()) throw new BridgeError(400, "Only regular files can be saved.");

  if (expectedVersion === undefined) {
    if (existing) throw new BridgeError(409, "A file with that name already exists.", { code: "file-exists" });
    // Exclusive create: a file that appears in between is never overwritten.
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new BridgeError(409, "A file with that name already exists.", { code: "file-exists" });
      throw error;
    });
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const created = await lstat(file);
    return { path: requested, version: fileVersion(created), size: created.size, created: true };
  }

  if (!existing) throw new BridgeError(409, "The file is gone. It changed since you opened it.", { code: "file-changed" });
  if (fileVersion(existing) !== expectedVersion) throw new BridgeError(409, "The file changed since you opened it.", { code: "file-changed" });
  const temporary = path.join(directory, `.${parts[parts.length - 1]}.phren-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, existing.mode & 0o777);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // Recheck right before the swap so a write that landed meanwhile is not lost.
    const current = await lstat(file).catch(() => undefined);
    if (!current || current.isSymbolicLink() || fileVersion(current) !== expectedVersion) {
      throw new BridgeError(409, "The file changed since you opened it.", { code: "file-changed" });
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  const saved = await lstat(file);
  return { path: requested, version: fileVersion(saved), size: saved.size, created: false };
}
