/**
 * RBAC enforcement for mutating MCP tools.
 *
 * Access-control.json lives at `<phrenPath>/.config/access-control.json` (global).
 * Per-project overrides live in `phren.project.yaml` under the `access` key.
 *
 * Schema:
 *   { admins: string[], contributors: string[], readers: string[] }
 *
 * Role hierarchy:
 *   admins       → all actions
 *   contributors → add/edit/remove findings, complete/add/remove tasks
 *   readers      → read-only (search, get)
 *
 * When no access-control.json exists, all actors are permitted (open mode).
 *
 * The actor is read from the PHREN_ACTOR env var (falls back to open if unset).
 */
type RbacAction = "add_finding" | "remove_finding" | "edit_finding" | "complete_task" | "add_task" | "remove_task" | "update_task" | "pin_task" | "claim_task" | "add_note" | "edit_note" | "remove_note" | "promote_note" | "manage_config";
/**
 * Appended to every ACL-write denial. The natural way to lock yourself out is
 * to run the very first `phren config access set --admins=someone-else`: that
 * turns open mode off and, because you are not in any list, every later edit
 * is denied. Recovery is a text edit, so say so rather than leaving the user
 * to guess.
 */
export declare const ACL_LOCKOUT_HINT = "Editing access control requires the `admins` role. To recover, edit `.config/access-control.json` in the store directly.";
export declare const ACCESS_ROLE_KEYS: readonly ["admins", "contributors", "readers"];
export type AccessRole = (typeof ACCESS_ROLE_KEYS)[number];
export type AccessRolePatch = Partial<Record<AccessRole, string[]>>;
/**
 * Single source of truth for writing access-control role lists. Writes to the
 * global `.config/access-control.json` or, when `project` is given, to that
 * project's `phren.project.yaml` under the `access` key (merged with any
 * existing roles). Returns the role lists as written at the chosen scope.
 *
 * Shared by the CLI (`phren config access`) and the MCP `set_config` tool so
 * the two paths can never diverge.
 */
export declare function setAccessRoles(phrenPath: string, patch: AccessRolePatch, project?: string): {
    admins: string[];
    contributors: string[];
    readers: string[];
};
/**
 * Convenience wrapper: returns a permission-denied MCP error string,
 * or null if the action is allowed.
 */
export declare function permissionDeniedError(phrenPath: string, action: RbacAction, project?: string | null): string | null;
export {};
