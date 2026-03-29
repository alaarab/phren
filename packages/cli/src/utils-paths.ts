import * as fs from "fs";
import * as path from "path";

// Validate a project name: lowercase letters/numbers with optional hyphen/underscore separators.
// Must not start with a hyphen (breaks CLI flags) or dot (hidden dirs). Max 100 chars.
// Internal keys like "native:-home" bypass this — they never go through user-facing validation.
// Explicitly rejects traversal sequences, null bytes, and path separators as defense-in-depth.
export function isValidProjectName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.length > 100) return false;
  // Reject null bytes, path separators, and traversal patterns before the regex check
  if (name.includes("\0") || name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

// Resolve a path inside the phren directory and reject anything that escapes it.
// Checks both lexical resolution and (when the path exists) real path after symlink
// resolution to prevent symlink-based traversal.
export function safeProjectPath(base: string, ...segments: string[]): string | null {
  // Reject segments containing null bytes
  for (const seg of segments) {
    if (seg.includes("\0")) return null;
  }
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(base, ...segments);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) return null;
  // Walk up from resolved path to find the deepest existing ancestor and verify
  // it resolves inside base after symlink resolution. This catches symlink escapes
  // even when the final leaf doesn't exist yet.
  try {
    let check = resolved;
    while (!fs.existsSync(check) && check !== resolvedBase) {
      check = path.dirname(check);
    }
    if (fs.existsSync(check)) {
      const realBase = fs.realpathSync.native(resolvedBase);
      const realCheck = fs.realpathSync.native(check);
      if (realCheck !== realBase && !realCheck.startsWith(realBase + path.sep)) return null;
    }
  } catch {
    // If realpath fails (e.g. broken symlink), reject to be safe
    return null;
  }
  return resolved;
}

const QUEUE_FILENAME = "review.md";

export function queueFilePath(phrenPath: string, project: string): string {
  if (!isValidProjectName(project)) {
    throw new Error(`Invalid project name: ${project}`);
  }
  const result = safeProjectPath(phrenPath, project, QUEUE_FILENAME);
  if (!result) {
    throw new Error(`Path traversal detected for project: ${project}`);
  }
  return result;
}
