/**
 * Privacy safeguards — scrub sensitive data from tool outputs, findings, and LLM context.
 *
 * Prevents accidental leakage of:
 * - API keys and tokens in tool output (e.g., from reading .env files)
 * - Passwords and connection strings
 * - PII patterns (emails, IPs shown in logs)
 * - Private keys and certificates
 *
 * Applied at three layers:
 * 1. Tool output → before sending to LLM (scrubToolOutput)
 * 2. Findings → before saving to phren (scrubFinding)
 * 3. Session summaries → before persisting (scrubSummary)
 */

// ── Secret patterns ──────────────────────────────────────────────────────

/** Patterns that match common API key/token formats. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Generic API keys (long hex/base64 strings prefixed by common env var names)
  { pattern: /(?:api[_-]?key|api[_-]?secret|api[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9_\-/.+=]{20,})["']?/gi, label: "API_KEY" },
  // AWS keys
  { pattern: /AKIA[0-9A-Z]{16}/g, label: "AWS_ACCESS_KEY" },
  { pattern: /(?:aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{30,})["']?/gi, label: "AWS_SECRET" },
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9_\-/.+=]{20,}/g, label: "BEARER_TOKEN" },
  // GitHub tokens
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, label: "GITHUB_TOKEN" },
  // Anthropic keys
  { pattern: /sk-ant-[A-Za-z0-9_\-]{20,}/g, label: "ANTHROPIC_KEY" },
  // OpenAI keys
  { pattern: /sk-[A-Za-z0-9]{20,}/g, label: "OPENAI_KEY" },
  // Generic password assignments
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"']{8,})["']?/gi, label: "PASSWORD" },
  // Connection strings with passwords
  { pattern: /:\/\/[^:]+:([^@\s]{8,})@/g, label: "CONNECTION_PASSWORD" },
  // Private key blocks
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, label: "PRIVATE_KEY" },
  // JWT tokens
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: "JWT" },
  // Slack tokens
  { pattern: /xox[bpras]-[0-9]{10,}-[A-Za-z0-9-]+/g, label: "SLACK_TOKEN" },
  // Env variable assignments with secret-ish names
  { pattern: /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|AUTH|CREDENTIAL)[A-Z_]*\s*=\s*["']?([^\s"']{8,})["']?/gi, label: "SECRET_VAR" },
];

/** Patterns for PII that shouldn't be stored in findings. */
const PII_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Email addresses (only redact in contexts where they're likely PII, not code)
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: "EMAIL" },
  // IP addresses (v4) — only in log-like contexts
  { pattern: /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}\b/g, label: "IP_ADDRESS" },
];

// ── Scrubbing functions ──────────────────────────────────────────────────

/**
 * Scrub sensitive data from tool output before it's sent to the LLM.
 * This is the primary privacy gate — catches secrets in file reads, command output, etc.
 */
export function scrubToolOutput(toolName: string, output: string): string {
  // Don't scrub short outputs (unlikely to contain full secrets)
  if (output.length < 20) return output;

  let scrubbed = output;

  for (const { pattern, label } of SECRET_PATTERNS) {
    // Reset regex state for global patterns
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, `[REDACTED:${label}]`);
  }

  return scrubbed;
}

/**
 * Check if a string contains likely secrets. Returns true if secrets detected.
 * Use this as a gate before saving to persistent storage.
 */
export function containsSecrets(text: string): boolean {
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Scrub sensitive data from a finding before saving to phren.
 * More aggressive than tool output scrubbing — also catches PII.
 */
export function scrubFinding(finding: string): string {
  let scrubbed = finding;

  // Secret patterns
  for (const { pattern, label } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, `[REDACTED:${label}]`);
  }

  // PII patterns (only in findings, not tool outputs where they may be needed)
  for (const { pattern, label } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, `[REDACTED:${label}]`);
  }

  return scrubbed;
}

/**
 * Scrub a session summary before persisting.
 */
export function scrubSummary(summary: string): string {
  return scrubFinding(summary);
}

/**
 * Check if tool output looks like it came from reading a sensitive file
 * (e.g., .env, credentials). Returns true if the content appears to be
 * mostly key-value secrets.
 */
export function looksLikeSecretsFile(output: string): boolean {
  const lines = output.split("\n").filter(l => l.trim() && !l.startsWith("#"));
  if (lines.length < 2) return false;

  let secretLines = 0;
  for (const line of lines) {
    // Count lines that look like KEY=secret_value
    if (/^[A-Z_]{2,}=\S+/.test(line)) {
      for (const { pattern } of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          secretLines++;
          break;
        }
      }
    }
  }

  // If >50% of non-comment lines are secrets, it's probably a secrets file
  return secretLines / lines.length > 0.5;
}

/**
 * Validate that a finding doesn't contain obvious secrets before saving.
 * Returns an error message if the finding should be rejected, null if OK.
 */
export function validateFindingSafety(finding: string): string | null {
  if (containsSecrets(finding)) {
    return "Finding contains detected secrets (API keys, tokens, passwords). Secrets should never be stored in findings. The sensitive values have been redacted.";
  }
  return null;
}
