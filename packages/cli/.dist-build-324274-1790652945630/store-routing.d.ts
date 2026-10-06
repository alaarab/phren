import { type StoreEntry } from "./store-registry.js";
export interface ResolvedProject {
    store: StoreEntry;
    projectName: string;
    projectDir: string;
}
export interface ParsedProjectRef {
    storeName?: string;
    projectName: string;
}
/**
 * Parse a project reference that may be store-qualified.
 *
 * "arc"          → { projectName: "arc" }
 * "arc-team/arc" → { storeName: "arc-team", projectName: "arc" }
 */
export declare function parseStoreQualified(input: string): ParsedProjectRef;
/**
 * Resolve a project reference to a specific store + directory.
 *
 * Resolution rules:
 * 1. If store-qualified ("store/project"), find that store and project within it
 * 2. If bare ("project"), scan all readable stores for a matching project dir
 * 3. Exactly one match → return it
 * 4. Zero matches → throw NOT_FOUND
 * 5. Multiple matches → throw VALIDATION_ERROR with disambiguation message
 */
export declare function resolveProject(phrenPath: string, input: string, profile?: string): ResolvedProject;
/**
 * List all projects across all readable stores.
 * Returns entries with store context for display.
 */
export declare function listAllProjects(phrenPath: string, profile?: string): Array<{
    store: StoreEntry;
    projectName: string;
    projectDir: string;
}>;
/**
 * Store-aware variant of safeProjectPath for callers holding the primary store
 * root: when the project directory does not exist in `phrenPath`, resolve the
 * owning store from the registry and build the path under it instead. Falls
 * back to the (nonexistent) primary-store path when the project is in no store
 * or is ambiguous, so callers' existing not-found handling fires unchanged.
 */
export declare function storeAwareProjectPath(phrenPath: string, project: string, ...segments: string[]): string | null;
