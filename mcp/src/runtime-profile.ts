import { resolveActiveProfile } from "./profile-store.js";

function requestedProfileFromEnv(): string | undefined {
  const profile = (process.env.PHREN_PROFILE)?.trim();
  return profile ? profile : undefined;
}

/**
 * Resolve the effective runtime profile for user-facing entrypoints.
 * Explicit env selection is strict. Implicit selection is best-effort via
 * machines.yaml / profiles and falls back to an unscoped view during early setup.
 */
export function resolveRuntimeProfile(phrenPath: string, requestedProfile: string | undefined = requestedProfileFromEnv()): string {
  const result = resolveActiveProfile(phrenPath, requestedProfile);
  if (result.ok) return result.data || "";
  if (requestedProfile) throw new Error(result.error);
  return "";
}
