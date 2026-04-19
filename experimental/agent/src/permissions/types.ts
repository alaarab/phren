/** Permission system types. */

export type PermissionMode = "suggest" | "auto-confirm" | "plan" | "full-auto";

export type PermissionVerdict = "allow" | "ask" | "deny";

export interface PermissionConfig {
  mode: PermissionMode;
  allowedPaths: string[];
  projectRoot: string;
}

export interface PermissionRule {
  verdict: PermissionVerdict;
  reason: string;
}
