/**
 * .phrenignore support — gitignore-syntax file that blocks agent tools
 * from accessing matching paths, enforced at the execution layer.
 *
 * Loaded once per session from the project root. Patterns are applied
 * to read_file, write_file, edit_file, glob, and grep tools.
 */
import * as fs from "fs";
import * as path from "path";

let ignorePatterns: RegExp[] | null = null;
let ignoreRoot: string | null = null;

/**
 * Load .phrenignore from the given project root.
 * Returns true if patterns were loaded, false if no file exists.
 */
export function loadIgnorePatterns(projectRoot: string): boolean {
  const ignorePath = path.join(projectRoot, ".phrenignore");
  if (!fs.existsSync(ignorePath)) {
    ignorePatterns = [];
    ignoreRoot = projectRoot;
    return false;
  }

  const content = fs.readFileSync(ignorePath, "utf-8");
  ignorePatterns = parseIgnoreFile(content);
  ignoreRoot = projectRoot;
  return true;
}

/**
 * Check if a file path is blocked by .phrenignore patterns.
 * Returns true if the path should be blocked.
 */
export function isIgnored(filePath: string): boolean {
  if (!ignorePatterns || ignorePatterns.length === 0) return false;

  // Make path relative to project root for matching
  let relative = filePath;
  if (ignoreRoot && path.isAbsolute(filePath)) {
    relative = path.relative(ignoreRoot, filePath);
  }

  // Normalize separators
  relative = relative.replace(/\\/g, "/");

  for (const pattern of ignorePatterns) {
    if (pattern.test(relative)) return true;
  }

  return false;
}

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
  let negate = false;
  let pat = pattern;

  // Handle negation (!)
  if (pat.startsWith("!")) {
    negate = true;
    pat = pat.slice(1);
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
 * Reset loaded patterns (for testing or session restart).
 */
export function resetIgnorePatterns(): void {
  ignorePatterns = null;
  ignoreRoot = null;
}
