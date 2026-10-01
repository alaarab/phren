/** Permission system types. */

export type PermissionMode = "suggest" | "auto-confirm" | "plan" | "full-auto";

export type PermissionVerdict = "allow" | "ask" | "deny";

export interface PermissionConfig {
  mode: PermissionMode;
  allowedPaths: string[];
  projectRoot: string;
  /** Declarative allow / ask / deny rules (permissions/rules.ts). */
  rules?: import("./rules.js").PermissionRules;
  /** Kernel write-fence for shell commands (bwrap). Default: "auto". */
  sandboxMode?: import("./kernel-sandbox.js").SandboxMode;
}

export interface PermissionRule {
  verdict: PermissionVerdict;
  reason: string;
}
