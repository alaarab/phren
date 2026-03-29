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

/** Patterns for accessing sensitive files via shell commands. */
const SENSITIVE_ACCESS_PATTERNS: RegExp[] = [
  /\bcat\b.*\.ssh\//i,
  /\bcat\b.*\.aws\//i,
  /\bcat\b.*\.env\b/i,
  /\bcat\b.*id_rsa/i,
  /\bcat\b.*id_ed25519/i,
  /\bcat\b.*credentials\.json/i,
  /\bcat\b.*secrets\.(json|yaml)/i,
  /\bcat\b.*\.pem\b/i,
  /\bcat\b.*\.key\b/i,
  /\bcat\b.*\.netrc/i,
  /\bcat\b.*\.npmrc/i,
  /\bless\b.*\.ssh\//i,
  /\bhead\b.*\.ssh\//i,
  /\btail\b.*\.ssh\//i,
  /\bbase64\b.*\.ssh\//i,
  /\bxxd\b.*\.ssh\//i,
  /\bcp\b.*\.ssh\//i,
  /\bscp\b.*\.ssh\//i,
];

/**
 * Check a shell command for dangerous patterns.
 */
export function checkShellSafety(command: string): ShellSafetyResult {
  for (const dp of DANGEROUS_PATTERNS) {
    if (dp.pattern.test(command)) {
      return { safe: false, reason: dp.reason, severity: dp.severity };
    }
  }

  // Check for sensitive file access via shell
  for (const pat of SENSITIVE_ACCESS_PATTERNS) {
    if (pat.test(command)) {
      return { safe: false, reason: "Accessing sensitive file via shell", severity: "block" };
    }
  }

  return { safe: true, reason: "", severity: "ok" };
}

/**
 * Check if a shell command contains chaining operators that could bypass allow rules.
 * Returns true if the command has multiple chained commands.
 */
export function hasCommandChaining(command: string): boolean {
  // Strip quoted strings to avoid false positives
  const stripped = command
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/\$\([^)]*\)/g, '$()');

  // Check for chaining operators outside quotes
  return /[;&|]{1,2}/.test(stripped) || /\|\s*\w/.test(stripped);
}

/**
 * Extract the first command from a potentially chained command string.
 * Used to check if an allow-rule match is valid (only matches the first command).
 */
export function extractFirstCommand(command: string): string {
  const stripped = command
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''");

  // Split on chaining operators
  const match = stripped.match(/^([^;&|]+)/);
  return match ? command.slice(0, match[1].length).trim() : command;
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
