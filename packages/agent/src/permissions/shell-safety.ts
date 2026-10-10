export interface ShellSafetyResult {
  safe: boolean;
  reason: string;
  severity: "block" | "warn" | "ok";
}

interface DangerousPattern {
  pattern: RegExp;
  reason: string;
  severity: "block" | "warn";
  /** Test the command with quoted arguments blanked (see `unquoted`). */
  commandOnly?: boolean;
}

// A command position: the start of the line or of a chained, piped or
// substituted command, after any wrapper such as sudo or xargs. Matching a
// word only here keeps `grep -rn setsid src` and `npx mkfs-tool` runnable.
const CMD = String.raw`(?:^|[\n;&|({\`]|\$\()\s*(?:(?:sudo|exec|command|nice|time|env|xargs)\s+(?:-\S+\s+)*)*`;
// The end of a word as the shell splits it.
const END = String.raw`(?=$|[\s;&|)])`;
// rm with a recursive flag anywhere in the same command (-r, -rf, -fR, --recursive).
const RM_RECURSIVE = String.raw`\brm\b(?=[^;&|]*\s-(?:[a-zA-Z]*[rR]|-recursive))[^;&|]*?\s["']?`;

function blocked(source: string, reason: string, commandOnly = true): DangerousPattern {
  return { pattern: new RegExp(source, "i"), reason, severity: "block", commandOnly };
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // Block: destructive/irreversible. rm targets are matched in the raw
  // command so quoting (`rm -rf "/"`) does not hide them; only `/`, `/*` and a
  // top-level directory such as `/etc` count, not a path under one.
  blocked(String.raw`${RM_RECURSIVE}\/\*?["']?${END}`, "Recursive delete of root filesystem", false),
  blocked(String.raw`${RM_RECURSIVE}\/[^\/\s"';&|*]+\/?\*?["']?${END}`, "Recursive delete of top-level directory", false),
  blocked(String.raw`${CMD}(?:curl|wget)\b.*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh${END}`, "Piping remote script to shell"),
  blocked(String.raw`${CMD}mkfs(?:\.\w+)?${END}`, "Filesystem format command"),
  blocked(String.raw`${CMD}dd\b.*\bof=\/dev\/(?!null\b|zero\b|std(?:out|err)\b|fd\/)`, "Direct device write with dd"),
  blocked(String.raw`>\s*\/dev\/[sh]d[a-z]`, "Direct write to block device"),
  blocked(String.raw`:\(\)\s*\{\s*:\|:&\s*\};:`, "Fork bomb", false),
  blocked(String.raw`${CMD}(?:nohup|disown|setsid)${END}`, "Detached process may outlive session"),

  // Block: Windows-specific destructive commands
  blocked(String.raw`${CMD}format\s+[a-z]:`, "Disk format command"),
  blocked(String.raw`${CMD}del\s+\/[sq]`, "Recursive or quiet delete"),
  blocked(String.raw`${CMD}(?:rd|rmdir)\s+\/s`, "Recursive directory removal"),
  blocked(String.raw`${CMD}reg\s+delete\b`, "Registry deletion"),
  blocked(String.raw`${CMD}(?:powershell|pwsh)\b.*\s-enc`, "Encoded PowerShell command (obfuscation)"),
  blocked(String.raw`${CMD}cmd\b.*\/c.*\bdel\s+\/[sq]`, "Recursive or quiet delete via cmd"),

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
 * The command with quoted arguments blanked, so a word that is only text
 * (`git commit -m 'drop nohup'`) is not read as a command. Quoted text after
 * `-c` or `eval` is itself run, so it stays, fenced as its own command line.
 */
function unquoted(command: string): string {
  return command.replace(/(-c\s+|\beval\s+)?('[^']*'|"(?:[^"\\]|\\.)*")/g, (_m, run: string | undefined, quoted: string) =>
    run ? `${run};${quoted.slice(1, -1)};` : "''",
  );
}

/**
 * Check a shell command for dangerous patterns.
 */
export function checkShellSafety(command: string): ShellSafetyResult {
  const commands = unquoted(command);
  for (const dp of DANGEROUS_PATTERNS) {
    if (dp.pattern.test(dp.commandOnly ? commands : command)) {
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
