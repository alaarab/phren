export interface ShellSafetyResult {
  safe: boolean;
  reason: string;
  severity: "block" | "warn" | "ok";
}

interface DangerousPattern {
  pattern: RegExp;
  reason: string;
  severity: "block" | "warn";
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // Block: destructive/irreversible (no $ anchors — catch chained commands like `rm -rf /; echo done`)
  { pattern: /rm\s+-[a-z]*r[a-z]*f?\s+\/\s*/i, reason: "Recursive delete of root filesystem", severity: "block" },
  { pattern: /rm\s+-[a-z]*r[a-z]*f?\s+\/[^\/\s]*/i, reason: "Recursive delete of top-level directory", severity: "block" },
  { pattern: /curl\s+.*\|\s*(?:ba)?sh/i, reason: "Piping remote script to shell", severity: "block" },
  { pattern: /wget\s+.*\|\s*(?:ba)?sh/i, reason: "Piping remote script to shell", severity: "block" },
  { pattern: /\bmkfs\b/i, reason: "Filesystem format command", severity: "block" },
  { pattern: /\bdd\b.*\bof=\/dev\//i, reason: "Direct device write with dd", severity: "block" },
  { pattern: />\s*\/dev\/[sh]d[a-z]/i, reason: "Direct write to block device", severity: "block" },
  { pattern: /:(){ :\|:& };:/i, reason: "Fork bomb", severity: "block" },
  { pattern: /\bnohup\b/i, reason: "Detached process may outlive session", severity: "block" },
  { pattern: /\bdisown\b/i, reason: "Detached process may outlive session", severity: "block" },
  { pattern: /\bsetsid\b/i, reason: "Detached process may outlive session", severity: "block" },

  // Warn: potentially dangerous
  { pattern: /\beval\b/i, reason: "Dynamic code execution via eval", severity: "warn" },
  { pattern: /\$\(.*\)/, reason: "Command substitution", severity: "warn" },
  { pattern: /`[^`]+`/, reason: "Command substitution via backticks", severity: "warn" },
  { pattern: /\benv\b/i, reason: "May expose environment variables", severity: "warn" },
  { pattern: /\bprintenv\b/i, reason: "May expose environment variables", severity: "warn" },
  { pattern: /\bsudo\b/i, reason: "Elevated privileges requested", severity: "warn" },
  { pattern: /\bgit\s+push\s+--force\b/i, reason: "Force push can rewrite remote history", severity: "warn" },
  { pattern: /\bgit\s+push\s+-f\b/i, reason: "Force push can rewrite remote history", severity: "warn" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "Hard reset discards uncommitted changes", severity: "warn" },
  { pattern: /\bchmod\s+777\b/, reason: "World-writable permissions", severity: "warn" },
  { pattern: /\bchown\b.*\broot\b/i, reason: "Changing ownership to root", severity: "warn" },
];

/** API key env var patterns to scrub. */
const KEY_PATTERNS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "DATABASE_URL",
  "KUBECONFIG",
  "DOCKER_AUTH_CONFIG",
  "PGPASSWORD",
  "MYSQL_PWD",
];

/** Suffix patterns that also match connection strings and auth configs. */
const SECRET_SUFFIX_PATTERNS = ["_URI", "_DSN"];

const SECRET_SUFFIXES = ["_SECRET", "_TOKEN", "_PASSWORD", "_KEY"];

/**
 * Check a shell command for dangerous patterns.
 */
export function checkShellSafety(command: string): ShellSafetyResult {
  for (const dp of DANGEROUS_PATTERNS) {
    if (dp.pattern.test(command)) {
      return { safe: false, reason: dp.reason, severity: dp.severity };
    }
  }
  return { safe: true, reason: "", severity: "ok" };
}

/**
 * Return a sanitized copy of process.env with API keys and secrets removed.
 */
export function scrubEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  for (const key of Object.keys(env)) {
    // Known API key vars
    if (KEY_PATTERNS.includes(key)) {
      delete env[key];
      continue;
    }
    // Anything ending with _SECRET, _TOKEN, _PASSWORD, _KEY, _URI, _DSN
    const upper = key.toUpperCase();
    if (SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix))) {
      delete env[key];
      continue;
    }
    if (SECRET_SUFFIX_PATTERNS.some((suffix) => upper.endsWith(suffix))) {
      delete env[key];
    }
  }

  return env;
}
