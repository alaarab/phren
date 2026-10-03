import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteText } from "../phren-paths.js";
import { withFileLock } from "../governance/locks.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { registeredStoreIdentity } from "../store-registry.js";

const file = (base: string) => path.join(base, ".config", "task-format.json");
export const taskFormatMigrationHint = "Task metadata is not enabled for this store. Upgrade every CLI, MCP, Hook, sync and app writer first; an owner can then run phren task format enable --all-writers-compatible. Existing writers must be replaced through the coordinated adoption workflow.";

/** Phone writes stay closed until the integrator establishes a compatible
 * adoption/fencing protocol for installed writers. The owner acknowledgement
 * below cannot enforce this: an old MCP process never reads that file.
 * No Hook version, capability, environment variable or config toggle lifts it. */
export function nativeTaskWriteBlock(base: string): "compatible-writer-adoption-required" | "legacy-writer-fence-required" {
  return taskFormatStatus(base).enabled ? "legacy-writer-fence-required" : "compatible-writer-adoption-required";
}

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
  const storeId = registeredStoreIdentity(base);
  if (!storeId) throw new Error("Register a portable store identity with phren store identity --create before enabling task metadata.");
  fs.mkdirSync(path.dirname(file(base)), { recursive: true });
  withFileLock(file(base), () => {
    if (taskFormatStatus(base).enabled) return;
    // A future-format or malformed file is evidence, not permission to replace it.
    if (fs.existsSync(file(base))) throw new Error("Existing task-format.json is unsupported or belongs to another store. Review it before enabling metadata.");
    atomicWriteText(file(base), JSON.stringify({ version: 1, storeId, allWritersCompatible: true, acknowledgedAt: new Date().toISOString() }, null, 2) + "\n");
  });
}
