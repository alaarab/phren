import * as path from "path";

/**
 * Path math that follows the path's own style, not the host's. A Windows
 * extension host reaches `C:\repo`, `\\wsl$\Ubuntu\home\me` and
 * `\\wsl.localhost\Ubuntu\home\me`; a Linux or macOS host (Remote, WSL) gets
 * POSIX paths, and a store may hand either style back. Choosing by shape keeps
 * every comparison correct wherever the code runs.
 */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || (p.includes("\\") && !p.includes("/"));
}

function pathApi(...paths: string[]): typeof path.posix {
  return paths.some(isWindowsPath) ? path.win32 : path.posix;
}

/**
 * `child` relative to `parent` when it is strictly inside it, else undefined.
 * Windows paths compare case-insensitively and accept either separator; the
 * result always uses forward slashes, the form citations and the code index use.
 */
export function relativeInside(parent: string, child: string): string | undefined {
  if (!parent || !child) return undefined;
  const p = pathApi(parent, child);
  const relative = p.relative(parent, child);
  if (!relative) return undefined;
  if (relative.split(/[\\/]/)[0] === ".." || p.isAbsolute(relative)) return undefined;
  // win32 comparison ignores case, but a WSL share is a Linux filesystem.
  if (isWslPath(parent) && !sameCaseSegments(parent, child)) return undefined;
  // A backslash is an ordinary filename character on POSIX; only Windows paths convert.
  return p === path.win32 ? relative.replace(/\\/g, "/") : relative;
}

function isWslPath(p: string): boolean {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(p);
}

/** Every segment of `parent` appears with identical case at the start of `child`. */
function sameCaseSegments(parent: string, child: string): boolean {
  const a = parent.split(/[\\/]/).filter(Boolean);
  const b = child.split(/[\\/]/).filter(Boolean);
  // The server segment (wsl$ / wsl.localhost) is case-insensitive; the rest is not.
  return a.every((seg, i) => (i === 0 ? seg.toLowerCase() === b[i]?.toLowerCase() : seg === b[i]));
}

/** The folder that holds `file`; when folders nest (multi-root) the deepest wins. */
export function containingFolder(folders: readonly string[], file: string): string | undefined {
  let best: string | undefined;
  for (const folder of folders) {
    if (relativeInside(folder, file) === undefined) continue;
    if (best === undefined || folder.length > best.length) best = folder;
  }
  return best;
}

/** True when two paths name the same place, ignoring separator style, trailing slashes and (Windows) case. */
export function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const p = pathApi(a, b);
  const windows = p === path.win32;
  // A WSL share is a Linux filesystem: its names keep their case.
  const foldCase = windows && !isWslPath(a) && !isWslPath(b);
  const norm = (value: string): string => {
    let n = p.normalize(value);
    if (n.length > 1) n = n.replace(/[\\/]+$/, "");
    return foldCase ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

/** The last path segment, for either separator. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
