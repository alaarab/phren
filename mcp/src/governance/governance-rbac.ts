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

import * as fs from "fs";
import * as path from "path";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";
import { readProjectConfig, type ProjectAccessControl } from "../project-config.js";

export type RbacAction =
  | "add_finding"
  | "remove_finding"
  | "edit_finding"
  | "complete_task"
  | "add_task"
  | "remove_task"
  | "update_task"
  | "manage_config";

interface AccessControl {
  admins?: string[];
  contributors?: string[];
  readers?: string[];
}

function configDir(phrenPath: string): string {
  return path.join(phrenPath, ".config");
}

function readGlobalAccessControl(phrenPath: string): AccessControl | null {
  const filePath = path.join(configDir(phrenPath), "access-control.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as AccessControl;
  } catch (err: unknown) {
    debugLog(`readGlobalAccessControl: failed to parse ${filePath}: ${errorMessage(err)}`);
    return null;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function mergeAccessControl(global: AccessControl | null, projectAccess: ProjectAccessControl | undefined): AccessControl | null {
  // If neither global nor project access is configured, open mode
  if (!global && !projectAccess) return null;

  const base = global ?? {};
  if (!projectAccess) return base;

  // Project-level access adds/replaces role lists; global is the baseline
  return {
    admins: [...new Set([...normalizeStringArray(base.admins), ...normalizeStringArray(projectAccess.admins)])],
    contributors: [...new Set([...normalizeStringArray(base.contributors), ...normalizeStringArray(projectAccess.contributors)])],
    readers: [...new Set([...normalizeStringArray(base.readers), ...normalizeStringArray(projectAccess.readers)])],
  };
}

function resolvedActorRole(actor: string, ac: AccessControl): "admin" | "contributor" | "reader" | "denied" {
  const admins = normalizeStringArray(ac.admins);
  const contributors = normalizeStringArray(ac.contributors);
  const readers = normalizeStringArray(ac.readers);

  // If all role lists are empty, treat as open
  if (!admins.length && !contributors.length && !readers.length) return "admin";

  if (admins.includes(actor)) return "admin";
  if (contributors.includes(actor)) return "contributor";
  if (readers.includes(actor)) return "reader";
  return "denied";
}

const CONTRIBUTOR_ACTIONS = new Set<RbacAction>([
  "add_finding",
  "remove_finding",
  "edit_finding",
  "complete_task",
  "add_task",
  "remove_task",
  "update_task",
]);

const ADMIN_ONLY_ACTIONS = new Set<RbacAction>([
  "manage_config",
]);

function rolePermits(role: "admin" | "contributor" | "reader" | "denied", action: RbacAction): boolean {
  if (role === "denied") return false;
  if (role === "admin") return true;
  if (ADMIN_ONLY_ACTIONS.has(action)) return false;
  if (role === "contributor") return CONTRIBUTOR_ACTIONS.has(action);
  // readers: no mutating actions
  return false;
}

export interface PermissionResult {
  allowed: boolean;
  actor: string | null;
  role: "admin" | "contributor" | "reader" | "denied" | "open";
  reason?: string;
}

/**
 * Check whether the current actor (from PHREN_ACTOR env var) is permitted to
 * perform `action`. When `project` is provided, merges global + per-project ACL.
 *
 * Returns `{ allowed: true }` when permitted, `{ allowed: false, reason }` when denied.
 */
export function checkPermission(
  phrenPath: string,
  action: RbacAction,
  project?: string | null,
): PermissionResult {
  const actor = (process.env.PHREN_ACTOR ?? "").trim() || null;

  const globalAc = readGlobalAccessControl(phrenPath);
  const projectAccess = project
    ? readProjectConfig(phrenPath, project).access
    : undefined;

  const effectiveAc = mergeAccessControl(globalAc, projectAccess);

  // Open mode: no access control configured at any level
  if (!effectiveAc) {
    return { allowed: true, actor, role: "open" };
  }

  // No actor env var set — check if we're in open mode still
  if (!actor) {
    // If all lists are empty, open
    const allEmpty =
      !normalizeStringArray(effectiveAc.admins).length &&
      !normalizeStringArray(effectiveAc.contributors).length &&
      !normalizeStringArray(effectiveAc.readers).length;
    if (allEmpty) return { allowed: true, actor, role: "open" };

    return {
      allowed: false,
      actor,
      role: "denied",
      reason: "PHREN_ACTOR is not set and access control is configured. Set PHREN_ACTOR to your username.",
    };
  }

  const role = resolvedActorRole(actor, effectiveAc);
  const allowed = rolePermits(role, action);

  if (!allowed) {
    const reason = role === "denied"
      ? `Actor "${actor}" is not listed in access-control for ${project ? `project "${project}"` : "global config"}.`
      : `Actor "${actor}" has role "${role}" which does not permit "${action}".`;
    return { allowed: false, actor, role, reason };
  }

  return { allowed: true, actor, role };
}

/**
 * Convenience wrapper: returns a permission-denied MCP error string,
 * or null if the action is allowed.
 */
export function permissionDeniedError(
  phrenPath: string,
  action: RbacAction,
  project?: string | null,
): string | null {
  const result = checkPermission(phrenPath, action, project);
  if (result.allowed) return null;
  return `Permission denied: ${result.reason ?? `actor "${result.actor}" cannot perform "${action}".`}`;
}
