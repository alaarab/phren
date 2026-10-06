import * as path from "path";
import * as fs from "fs";
import * as os from "os";

/** Patterns that match sensitive files/directories. */
const SENSITIVE_PATTERNS = [
  "/.ssh/",
  "/.aws/",
  ".env",
  "codex-token.json",
  "id_rsa",
  "id_ed25519",
  "/etc/shadow",
  "/etc/passwd",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  ".npmrc",
  ".netrc",
  ".docker/config.json",
  ".kube/config",
  "/.gnupg/",
  ".pypirc",
];

/** File extensions that are always sensitive. */
const SENSITIVE_EXTENSIONS = [".pem", ".p12", ".pfx", ".key", ".keystore", ".jks"];

export type PathValidation =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

/** Canonicalize even a not-yet-created file through its nearest existing
 * ancestor. Broken/looping links and access errors cannot grant a boundary. */
function canonicalPath(filePath: string): string {
  let current = filePath;
  const missing: string[] = [];
  for (let depth = 0; depth < 256; depth++) {
    try {
      // The native implementation preserves kernel symlink/.. semantics.
      return path.join(fs.realpathSync.native(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // realpath also reports ENOENT for dangling symlinks. Unlike an absent
      // filename, those must not fall back to a lexical path inside the root.
      if (fs.lstatSync(current, { throwIfNoEntry: false })) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
  throw new Error("Path exceeds the ancestor resolution limit.");
}

function expandHome(filePath: string): string {
  return filePath === "~" || filePath.startsWith("~/")
    ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

/**
 * Resolve and validate a file path against the sandbox boundary.
 */
export function validatePath(
  filePath: string,
  projectRoot: string,
  allowedPaths: string[],
): PathValidation {
  let resolved: string, root: string, allowed: string[];
  try {
    const absoluteRoot = path.resolve(expandHome(projectRoot));
    // Preserve .. until filesystem resolution: link/../file follows the
    // link before traversing its parent, unlike path.resolve's lexical fold.
    const requested = expandHome(filePath);
    resolved = canonicalPath(path.isAbsolute(requested) ? requested : absoluteRoot + path.sep + requested);
    root = canonicalPath(absoluteRoot);
    allowed = allowedPaths.map(value => canonicalPath(path.resolve(absoluteRoot, expandHome(value))));
  } catch {
    return { ok: false, error: `Path "${filePath}" could not be safely resolved.` };
  }

  // Check sandbox boundaries
  if (!isPathInSandbox(resolved, root, allowed)) {
    return {
      ok: false,
      error: `Path "${resolved}" is outside project root "${projectRoot}" and not in allowed paths.`,
    };
  }

  return { ok: true, resolved };
}

/**
 * Check if a resolved path is within the project root or any allowed path.
 */
export function isPathInSandbox(
  resolved: string,
  projectRoot: string,
  allowedPaths: string[],
): boolean {
  const normalizedResolved = path.normalize(resolved) + path.sep;
  const normalizedRoot = path.normalize(projectRoot) + path.sep;

  if (normalizedResolved.startsWith(normalizedRoot) || resolved === projectRoot) {
    return true;
  }

  for (const allowed of allowedPaths) {
    let normalizedAllowed = allowed;
    if (normalizedAllowed.startsWith("~/") || normalizedAllowed === "~") {
      normalizedAllowed = path.join(os.homedir(), normalizedAllowed.slice(1));
    }
    normalizedAllowed = path.normalize(normalizedAllowed) + path.sep;
    if (normalizedResolved.startsWith(normalizedAllowed) || resolved === path.normalize(allowed)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a resolved path matches any known sensitive pattern.
 */
export function checkSensitivePath(resolved: string): { sensitive: boolean; reason?: string } {
  const normalizedLower = resolved.toLowerCase();
  const ext = path.extname(resolved).toLowerCase();

  if (SENSITIVE_EXTENSIONS.includes(ext)) {
    return { sensitive: true, reason: `Sensitive file extension: ${ext}` };
  }

  for (const pattern of SENSITIVE_PATTERNS) {
    if (normalizedLower.includes(pattern.toLowerCase())) {
      return { sensitive: true, reason: `Matches sensitive pattern: ${pattern}` };
    }
  }

  return { sensitive: false };
}
