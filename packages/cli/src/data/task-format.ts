import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteText } from "../phren-paths.js";
import { withFileLock } from "../governance/locks.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { registeredStoreIdentity, registerStoreIdentity } from "../store-registry.js";

const file = (base: string) => path.join(base, ".config", "task-format.json");
/** The oldest writers that keep task metadata when they rewrite a task. */
export const taskFormatCurrentWriters = "Phren CLI, MCP and Hook 0.3.30, iOS build 177, Android 1.0.5";
export const taskFormatMigrationHint = `Task metadata is off for this store. Once every app and tool that writes it is current (${taskFormatCurrentWriters} or later), an owner can turn it on with phren task format enable --all-writers-compatible.`;

/** An explicit store-owner acknowledgement, not inferred from one serving Hook.
 * It cannot fence an old binary that ignores this file: coordinated adoption of
 * every writer remains a prerequisite, and is stated at the activation boundary. */
export function taskFormatStatus(base: string): { enabled: boolean; version: 1; acknowledgedAt?: string } {
  try {
    const value = JSON.parse(fs.readFileSync(file(base), "utf8"));
    if (value?.version === 1 && value.allWritersCompatible === true && typeof value.storeId === "string"
      && value.storeId === registeredStoreIdentity(base) && typeof value.acknowledgedAt === "string"
      && Number.isFinite(Date.parse(value.acknowledgedAt))) {
      return { enabled: true, version: 1, acknowledgedAt: value.acknowledgedAt };
    }
  } catch { /* Missing, malformed or unsupported activation remains disabled. */ }
  return { enabled: false, version: 1 };
}

/** Wire status describes admission, never proof that old filesystem/Git writers
 * have been upgraded. Such writers do not consult our activation file. */
export function taskWriterSafety(base: string) {
  const status = taskFormatStatus(base);
  return {
    version: 1 as const,
    metadataVersion: 1 as const,
    activation: status.enabled ? "owner-acknowledged" as const : "disabled" as const,
    requiresCoordinatedAdoption: true as const,
    legacyWritersFenced: false as const,
    ...(status.acknowledgedAt ? { acknowledgedAt: status.acknowledgedAt } : {}),
  };
}

export function enableTaskFormat(base: string, allWritersCompatible: boolean): void {
  const denied = permissionDeniedError(base, "manage_config");
  if (denied) throw new Error(denied);
  if (allWritersCompatible !== true) throw new Error(taskFormatMigrationHint);
  // Enabling is the owner's explicit act on this store, so a legacy store
  // without a portable identity gets one here instead of needing a second command.
  writeTaskFormat(base, registerStoreIdentity(base));
}

/** A store phren has just created has no old writers, so metadata starts on. */
export function initializeTaskFormat(base: string): void {
  writeTaskFormat(base, registerStoreIdentity(base));
}

function writeTaskFormat(base: string, storeId: string): void {
  fs.mkdirSync(path.dirname(file(base)), { recursive: true });
  withFileLock(file(base), () => {
    if (taskFormatStatus(base).enabled) return;
    // A future-format or malformed file is evidence, not permission to replace it.
    if (fs.existsSync(file(base))) throw new Error("Existing task-format.json is unsupported or belongs to another store. Review it before enabling metadata.");
    atomicWriteText(file(base), JSON.stringify({ version: 1, storeId, allWritersCompatible: true, acknowledgedAt: new Date().toISOString() }, null, 2) + "\n");
  });
}
