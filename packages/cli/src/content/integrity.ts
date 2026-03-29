/**
 * Finding integrity checks — detect prompt injection, dangerous commands,
 * authority escalation, and self-replication attempts in findings before
 * they are persisted.
 *
 * This is the data-layer safety gate. Every finding write path (MCP tools,
 * CLI commands, agent imports) flows through core/finding.ts which calls
 * checkFindingIntegrity() before saving.
 */

export type FindingRisk = "none" | "low" | "medium" | "high";

export interface FindingIntegrityResult {
  safe: boolean;
  risk: FindingRisk;
  flags: string[];
}

// ── Pattern categories ─────────────────────────────────────────────────────

/**
 * Patterns that indicate prompt injection — text trying to override AI instructions.
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

  const hasHighSeverity = flags.some(
    f => f.startsWith("prompt_injection:") || f.startsWith("dangerous_command:") || f === "authority_escalation:disable_safety",
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
