const DANGEROUS_PATTERNS = [
    // Block: destructive/irreversible
    { pattern: /rm\s+-[a-z]*r[a-z]*f?\s+\/\s*$/i, reason: "Recursive delete of root filesystem", severity: "block" },
    { pattern: /rm\s+-[a-z]*r[a-z]*f?\s+\/[^\/\s]*\s*$/i, reason: "Recursive delete of top-level directory", severity: "block" },
    { pattern: /curl\s+.*\|\s*(?:ba)?sh/i, reason: "Piping remote script to shell", severity: "block" },
    { pattern: /wget\s+.*\|\s*(?:ba)?sh/i, reason: "Piping remote script to shell", severity: "block" },
    { pattern: /\bmkfs\b/i, reason: "Filesystem format command", severity: "block" },
    { pattern: /\bdd\b.*\bof=\/dev\//i, reason: "Direct device write with dd", severity: "block" },
    { pattern: />\s*\/dev\/[sh]d[a-z]/i, reason: "Direct write to block device", severity: "block" },
    { pattern: /:(){ :\|:& };:/i, reason: "Fork bomb", severity: "block" },
    // Warn: potentially dangerous
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
];
const SECRET_SUFFIXES = ["_SECRET", "_TOKEN", "_PASSWORD"];
/**
 * Check a shell command for dangerous patterns.
 */
export function checkShellSafety(command) {
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
export function scrubEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        // Known API key vars
        if (KEY_PATTERNS.includes(key)) {
            delete env[key];
            continue;
        }
        // Anything ending with _SECRET, _TOKEN, or _PASSWORD
        const upper = key.toUpperCase();
        if (SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix))) {
            delete env[key];
        }
    }
    return env;
}
