export declare const AGENT_INSTRUCTIONS_FILENAME = "AGENTS.md";
export declare const LEGACY_AGENT_INSTRUCTIONS_FILENAME = "CLAUDE.md";
/** Resolve instructions without changing the store. New files always win. */
export declare function resolveAgentInstructionsPath(scopeDir: string): string | null;
/**
 * Copy legacy instructions to AGENTS.md once. The legacy source is retained so
 * an interrupted upgrade, older Phren client, or hand-written Claude setup
 * cannot lose data. When both files exist AGENTS.md remains authoritative and
 * neither file is modified.
 */
export declare function migrateLegacyAgentInstructions(scopeDir: string): boolean;
export declare function migrateStoreAgentInstructions(phrenPath: string): string[];
