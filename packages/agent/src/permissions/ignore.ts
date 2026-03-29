/**
 * .phrenignore support — gitignore-syntax file that blocks agent tools
 * from accessing matching paths, enforced at the execution layer.
 *
 * Loaded once per session from the project root. Patterns are applied
 * to read_file, write_file, edit_file, glob, and grep tools.
 */
import * as fs from "fs";
import * as path from "path";

/** Instance-scoped ignore context for multi-agent safety. */
export interface IgnoreContext {
  /** Check if a file path is blocked by .phrenignore patterns. */
  isIgnored: (filePath: string) => boolean;
}

/**
 * Load .phrenignore from the given project root.
 * Returns an IgnoreContext with an `isIgnored` method bound to the loaded patterns.
 */
export function loadIgnorePatterns(projectRoot: string): IgnoreContext {
  const ignorePath = path.join(projectRoot, ".phrenignore");
  let patterns: RegExp[] = [];

  if (fs.existsSync(ignorePath)) {
    const content = fs.readFileSync(ignorePath, "utf-8");
    patterns = parseIgnoreFile(content);
  }

  const root = projectRoot;

  return {
    isIgnored(filePath: string): boolean {
      if (patterns.length === 0) return false;

      // Make path relative to project root for matching
      let relative = filePath;
      if (path.isAbsolute(filePath)) {
        relative = path.relative(root, filePath);
      }

      // Normalize separators
      relative = relative.replace(/\\/g, "/");

      for (const pattern of patterns) {
        if (pattern.test(relative)) return true;
      }

      return false;
    },
  };
}

/** Default no-op context (nothing is ignored). */
export const emptyIgnoreContext: IgnoreContext = {
  isIgnored: () => false,
};

/**
 * Parse a gitignore-style file into an array of RegExp patterns.
 */
function parseIgnoreFile(content: string): RegExp[] {
  const patterns: RegExp[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    // Convert gitignore pattern to regex
    const regex = gitignoreToRegex(line);
    if (regex) patterns.push(regex);
  }

  return patterns;
}

/**
 * Convert a single gitignore pattern to a RegExp.
 */
function gitignoreToRegex(pattern: string): RegExp | null {
  let pat = pattern;

  // Negation patterns (!) are not supported — skip them
  if (pat.startsWith("!")) {
    return null;
  }

  // Handle directory-only patterns (trailing /)
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);

  // Handle leading /  (anchored to root)
  const anchored = pat.startsWith("/");
  if (anchored) pat = pat.slice(1);

  // Escape regex specials except * and ?
  let regex = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§GLOBSTAR§")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/§GLOBSTAR§/g, ".*");

  // If not anchored and no /, match anywhere in path
  if (!anchored && !pat.includes("/")) {
    regex = `(?:^|/)${regex}`;
  } else {
    regex = `^${regex}`;
  }

  // Directory-only: must match a directory component
  if (dirOnly) {
    regex += "(?:/|$)";
  } else {
    regex += "(?:/.*)?$";
  }

  try {
    return new RegExp(regex);
  } catch {
    return null;
  }
}

/**
 * @deprecated Use loadIgnorePatterns() which returns an IgnoreContext instance.
 * Kept for backward compatibility.
 */
export function resetIgnorePatterns(): void {
  // No-op — state is now instance-scoped via IgnoreContext
}
