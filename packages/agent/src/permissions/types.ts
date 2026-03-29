/** Permission system types. */

export type PermissionMode = "suggest" | "auto-confirm" | "full-auto";

export type PermissionVerdict = "allow" | "ask" | "deny";

/**
 * A permission rule pattern, e.g.:
 * - "Bash(npm run *)" — allow bash commands matching the glob
 * - "Read(/src/**)" — allow reading files under /src
 * - "WebFetch(domain:example.com)" — allow fetching from a domain
 * - "edit_file" — bare tool name (matches all invocations)
 */
export interface PermissionPattern {
  /** The tool name this pattern applies to. */
  tool: string;
  /** Optional argument pattern. For Bash: command glob. For file tools: path glob. For WebFetch: domain. */
  pattern?: string;
  /** What this rule does. */
  verdict: PermissionVerdict;
}

export interface PermissionConfig {
  mode: PermissionMode;
  allowedPaths: string[];
  projectRoot: string;
  /** Granular allow rules — patterns that auto-approve matching tool calls. */
  allowRules?: PermissionPattern[];
  /** Granular deny rules — patterns that block matching tool calls. Takes priority over allow. */
  denyRules?: PermissionPattern[];
}

export interface PermissionRule {
  verdict: PermissionVerdict;
  reason: string;
}
