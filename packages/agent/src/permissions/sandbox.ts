import * as path from "path";
import * as fs from "fs";
import * as os from "os";

/** Patterns that match sensitive files/directories. */
const SENSITIVE_PATTERNS = [
  "/.ssh/",
  "/.aws/",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.staging",
  "codex-token.json",
  "id_rsa",
  "id_ed25519",
  "/etc/shadow",
  "/etc/passwd",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  ".npmrc",
  ".netrc",
  ".docker/config.json",
  ".kube/config",
  "/.gnupg/",
  ".pypirc",
  "token.json",
  "gcloud/credentials",
  ".config/gh/hosts.yml",
  "serviceAccountKey.json",
  "firebase-adminsdk",
  ".htpasswd",
  "master.key",
  "credentials.yml.enc",
  ".vault-token",
  "vault.json",
];

/** File extensions that are always sensitive. */
const SENSITIVE_EXTENSIONS = [".pem", ".p12", ".pfx", ".key", ".keystore", ".jks", ".cer", ".crt"];

export type PathValidation =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

/**
 * Resolve and validate a file path against the sandbox boundary.
 */
export function validatePath(
  filePath: string,
  projectRoot: string,
  allowedPaths: string[],
): PathValidation {
  // Resolve ~ to home directory
  let resolved = filePath;
  if (resolved.startsWith("~/") || resolved === "~") {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }

  // Resolve to absolute
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(projectRoot, resolved);
  }

  // Normalize (remove .., trailing slashes, etc.)
  resolved = path.normalize(resolved);

  // Resolve symlinks if the path exists
  try {
    if (fs.existsSync(resolved)) {
      resolved = fs.realpathSync(resolved);
    }
  } catch {
    // If we can't resolve, proceed with the normalized path
  }

  // Check sandbox boundaries
  if (!isPathInSandbox(resolved, projectRoot, allowedPaths)) {
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
