import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./protocol.js";

const MAX_BYTES = 2_097_152;

/** Read-only browsing beneath a root selected and verified by the server. */
export async function browseFiles(root: string, relative: string) {
  if (relative.length > 4096 || relative.includes("\0") || relative.includes("\\") || path.isAbsolute(relative)
      || relative.split("/").some(part => part === ".." || part === ".git")) {
    throw new BridgeError(400, "Invalid repository path.");
  }
  const base = await realpath(root);
  let file = base;
  for (const part of relative.split("/").filter(part => part && part !== ".")) {
    file = path.join(file, part);
    if ((await lstat(file)).isSymbolicLink()) throw new BridgeError(403, "Symbolic links cannot be browsed.");
  }
  const resolved = await realpath(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new BridgeError(403, "The path is outside this repository.");
  const metadata = await lstat(resolved);
  if (metadata.isDirectory()) {
    const entries = (await readdir(resolved, { withFileTypes: true }))
      .filter(entry => entry.name !== ".git" && (entry.isDirectory() || entry.isFile()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return { path: relative, kind: "directory", truncated: entries.length > 500,
      entries: entries.slice(0, 500).map(entry => ({ name: entry.name, path: path.posix.join(relative, entry.name), kind: entry.isDirectory() ? "directory" : "file" })) };
  }
  if (!metadata.isFile()) throw new BridgeError(400, "Only regular files can be viewed.");
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== metadata.ino || current.dev !== metadata.dev) throw new BridgeError(409, "The file changed. Refresh and try again.");
    if (current.size > MAX_BYTES) throw new BridgeError(413, "Choose a file smaller than 2 MB.");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_BYTES) throw new BridgeError(413, "Choose a file smaller than 2 MB.");
    return { path: relative, kind: "file", size, data: bytes.subarray(0, size).toString("base64") };
  } finally { await handle.close(); }
}
