/**
 * Resolve the effective runtime profile for user-facing entrypoints.
 * Explicit env selection is strict. Implicit selection is best-effort via
 * machines.yaml / profiles and falls back to an unscoped view during early setup.
 */
export declare function resolveRuntimeProfile(phrenPath: string, requestedProfile?: string | undefined): string;
