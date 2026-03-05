import * as path from "path";

// Validate a project name: no path separators, no dot-dot segments, no null bytes
export function isValidProjectName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return true;
}

// Resolve a path inside the cortex directory and reject anything that escapes it
export function safeProjectPath(base: string, ...segments: string[]): string | null {
  const resolved = path.resolve(base, ...segments);
  const normalizedBase = path.resolve(base) + path.sep;
  if (!resolved.startsWith(normalizedBase) && resolved !== path.resolve(base)) return null;
  return resolved;
}

// Sanitize user input before passing it to an FTS5 MATCH expression.
// Strips FTS5-specific syntax that could cause injection or parse errors.
export function sanitizeFts5Query(raw: string): string {
  let q = raw.replace(/\0/g, "");
  q = q.replace(/\b(content|type|project|filename|path):/gi, "");
  q = q.replace(/\^/g, "");
  q = q.replace(/"/g, "");
  return q.trim();
}
