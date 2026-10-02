import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { readFileRange } from "./file-range.js";
import { BridgeError } from "./protocol.js";

function beneath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve a chat reference in a server-selected repository. Cwd-relative
 * names win over root-relative ones. Never turn an outside absolute path
 * into an unrelated in-repository suffix match. Metadata is checked by the
 * same no-symlink reader that will subsequently serve the file's bytes. */
export async function resolveFilePath(root: string, cwd: string, requested: string) {
  if (!requested || requested.length > 4096 || /[\x00-\x1f\x7f\\]/.test(requested)
      || requested.split("/").includes(".git") || path.win32.isAbsolute(requested) && !path.isAbsolute(requested)) {
    throw new BridgeError(400, "Invalid file path.");
  }
  const base = await realpath(root), folder = await realpath(cwd);
  if (!beneath(base, folder)) throw new BridgeError(403, "This folder is outside the repository.");
  // macOS /tmp is an alias of /private/tmp. Preserve a trusted cwd's root
  // spelling without resolving any client-supplied symlink beneath it.
  const roots = [base, path.resolve(root), path.resolve(cwd, path.relative(folder, base))];
  const absolute = path.isAbsolute(requested);
  const alias = roots.find(candidate => requested === candidate || requested.startsWith(candidate + path.sep));
  if (absolute && !alias) throw new BridgeError(403, "This file is outside the repository.");
  const candidates = absolute ? [{ start: base, name: requested.slice(alias!.length) }]
    : [...new Set([folder, base])].map(start => ({ start, name: requested }));
  for (const candidate of candidates) {
    try {
      let file = candidate.start;
      // Walk before normalizing '..': link/../file must not hide a symlink,
      // nor may a path leave the repository and then come back into it.
      for (const part of candidate.name.split("/").filter(part => part && part !== ".")) {
        file = path.resolve(file, part);
        if (!beneath(base, file)) throw new BridgeError(403, "This file is outside the repository.");
        if ((await lstat(file)).isSymbolicLink()) throw new BridgeError(403, "Symbolic links cannot be opened.");
      }
      const relative = path.relative(base, file).split(path.sep).join("/");
      const metadata = await readFileRange(base, relative, 0, 0);
      return { path: relative, size: metadata.total, contentType: metadata.contentType, version: metadata.version };
    } catch (error) {
      // Only a missing name permits a root-relative fallback. A symlink or
      // other rejected cwd candidate must not silently select another file.
      if (error instanceof BridgeError && error.status === 404) continue;
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
  }
  throw new BridgeError(404, "This file is no longer available.");
}
