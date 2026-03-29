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

// ── Finding integrity checks ────────────────────────────────────────────

export type FindingRisk = "none" | "low" | "medium" | "high";

export interface FindingIntegrityResult {
  safe: boolean;
  risk: FindingRisk;
  flags: string[];
}

/**
 * Patterns that indicate prompt injection — text trying to override AI instructions.
 * Each entry: [regex, flag label].
 */
const PROMPT_INJECTION_PATTERNS: Array<[RegExp, string]> = [
  // Direct instruction override attempts
  [/\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier|your|the|safety|system)\b/i, "prompt_injection:instruction_override"],
  [/\byou\s+(?:must|should|shall|will|are\s+(?:now|required\s+to))\b/i, "prompt_injection:directive"],
  [/\byour\s+new\s+(?:instructions?|role|purpose|directive)\b/i, "prompt_injection:role_reassignment"],
  [/\bas\s+an?\s+(?:AI|language\s+model|assistant|LLM)\b/i, "prompt_injection:identity_framing"],
  [/\bforget\s+everything\b/i, "prompt_injection:memory_wipe"],
  // System prompt markers (ChatML, Llama, etc.)
  [/\[INST\]|\[\/INST\]/i, "prompt_injection:chatml_inst"],
  [/<<SYS>>|<<\/SYS>>/i, "prompt_injection:llama_sys"],
  [/<\|im_start\|>|<\|im_end\|>/i, "prompt_injection:chatml_marker"],
  [/^system\s*:/im, "prompt_injection:system_prefix"],
  [/SYSTEM\s*:\s*you\s+are/i, "prompt_injection:system_role"],
  // Jailbreak-style keywords
  [/\b(?:DAN|do\s+anything\s+now|jailbreak)\b/i, "prompt_injection:jailbreak_keyword"],
];

/**
 * Patterns for dangerous executable instructions embedded in findings.
 */
const DANGEROUS_COMMAND_PATTERNS: Array<[RegExp, string]> = [
  // Pipe-to-shell patterns
  [/\bcurl\s+[^\s|]*\s*\|\s*(?:sh|bash|zsh|eval)\b/i, "dangerous_command:curl_pipe_shell"],
  [/\bwget\s+[^\s|]*\s*\|\s*(?:sh|bash|zsh|eval)\b/i, "dangerous_command:wget_pipe_shell"],
  // Dangerous eval/exec
  [/\beval\s*\(\s*['"`].*['"`]\s*\)/i, "dangerous_command:eval_literal"],
  [/\bexec\s*\(\s*['"`].*['"`]\s*\)/i, "dangerous_command:exec_literal"],
  // Destructive commands
  [/\brm\s+-rf\s+[/~]/i, "dangerous_command:rm_rf_root"],
  [/\bdd\s+.*\bof=\/dev\//i, "dangerous_command:dd_device"],
  [/\bmkfs\b/i, "dangerous_command:mkfs"],
  // Instructions to always run dangerous commands
  [/\b(?:always|first)\s+run\s+[`"'].*(?:curl|wget|rm\s+-rf|chmod\s+777|sudo)/i, "dangerous_command:instruction_to_run"],
];

/**
 * Patterns for authority/permission escalation claims.
 */
const AUTHORITY_ESCALATION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:user|admin|owner)\s+has\s+(?:authorized|approved|granted|confirmed)\b/i, "authority_escalation:false_authorization"],
  [/\bfull\s+(?:access|permission|control)\s+(?:granted|given|enabled)\b/i, "authority_escalation:false_access"],
  [/\bskip\s+(?:validation|verification|safety|security|auth)\b/i, "authority_escalation:skip_safety"],
  [/\bno\s+need\s+to\s+(?:ask|confirm|verify|validate|check)\b/i, "authority_escalation:skip_confirmation"],
  [/\bauto[-\s]?(?:approve|accept|confirm)\s+(?:all|every)\b/i, "authority_escalation:auto_approve"],
  [/\bdisable\s+(?:safety|security|protection|guard|check|filter)\b/i, "authority_escalation:disable_safety"],
];

/**
 * Patterns for self-replication — findings that instruct saving more findings.
 */
const SELF_REPLICATION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:save|add|create|write|store|append)\s+(?:this\s+)?(?:finding|memory|memories|findings)\b/i, "self_replication:save_finding"],
  [/\badd_finding\b/i, "self_replication:tool_invocation"],
  [/\bremember\s+to\s+always\b/i, "self_replication:persistent_instruction"],
  [/\b(?:when|if)\s+you\s+see\s+this\b/i, "self_replication:conditional_trigger"],
  [/\bspread\s+(?:this|the)\s+(?:message|finding|memory)\b/i, "self_replication:spread_instruction"],
];

/**
 * Check a finding for integrity issues — prompt injection, dangerous commands,
 * authority escalation, and self-replication attempts.
 *
 * Returns a structured result with risk level and triggered flags.
 * Risk levels:
 * - "none": no issues detected
 * - "low": one minor flag, likely benign but noted
 * - "medium": multiple flags or a single concerning pattern
 * - "high": strong prompt injection or dangerous command pattern
 */
export function checkFindingIntegrity(finding: string): FindingIntegrityResult {
  const flags: string[] = [];

  // Check all pattern categories
  for (const [pattern, flag] of PROMPT_INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(finding)) flags.push(flag);
  }
  for (const [pattern, flag] of DANGEROUS_COMMAND_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(finding)) flags.push(flag);
  }
  for (const [pattern, flag] of AUTHORITY_ESCALATION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(finding)) flags.push(flag);
  }
  for (const [pattern, flag] of SELF_REPLICATION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(finding)) flags.push(flag);
  }

  if (flags.length === 0) {
    return { safe: true, risk: "none", flags: [] };
  }

  // Determine risk level based on count and severity
  const hasHighSeverity = flags.some(
    f => f.startsWith("prompt_injection:") || f.startsWith("dangerous_command:") || f.startsWith("authority_escalation:disable_safety"),
  );
  const hasMediumSeverity = flags.some(
    f => f.startsWith("authority_escalation:") || f.startsWith("self_replication:"),
  );

  let risk: FindingRisk;
  if (hasHighSeverity || flags.length >= 3) {
    risk = "high";
  } else if (hasMediumSeverity || flags.length >= 2) {
    risk = "medium";
  } else {
    risk = "low";
  }

  return { safe: risk !== "high", risk, flags };
}
