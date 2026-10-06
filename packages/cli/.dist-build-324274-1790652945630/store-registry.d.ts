export type StoreRole = "primary" | "team" | "readonly";
export type StoreSyncMode = "managed-git" | "pull-only";
export interface StoreEntry {
    /** Immutable 8-char hex identifier. */
    id: string;
    /** Human-readable name (unique within registry). */
    name: string;
    /** Absolute path to the store root directory. */
    path: string;
    /** Store role — determines read/write/sync behavior. */
    role: StoreRole;
    /** Git remote URL (optional). */
    remote?: string;
    /** Sync mode for git operations. */
    sync: StoreSyncMode;
    /** Projects claimed by this store (for write routing in phase 2). */
    projects?: string[];
    /**
     * Whether {@link path} exists on this machine. Computed by
     * {@link resolveAllStores}; never persisted to stores.yaml. `undefined` on
     * hand-built entries that never went through resolution.
     */
    available?: boolean;
}
export interface StoreRegistry {
    version: 1;
    stores: StoreEntry[];
}
/** Bootstrap metadata committed to a team store repo root. */
export interface TeamBootstrap {
    name: string;
    description?: string;
    default_role?: StoreRole;
}
/**
 * The synced registry at the store root. It holds the primary store's entry
 * only, so every machine on this personal store agrees on its id. Team and
 * readonly stores used to live here too, which pushed one machine's `team
 * join` onto every other machine and left doctor failing forever there.
 */
export declare const STORES_FILENAME = "stores.yaml";
/**
 * The stores attached on this machine, under `.runtime/` (never synced).
 * Using the personal store must never connect a machine to a team store.
 */
export declare const ATTACHED_STORES_FILENAME = "attached-stores.yaml";
export declare function storesFilePath(phrenPath: string): string;
export declare function attachedStoresFilePath(phrenPath: string): string;
export declare function generateStoreId(): string;
/**
 * What a registry read actually found: the primary store from the synced
 * stores.yaml plus the stores attached on this machine. `registry` is what
 * could be honored; `problems` says what couldn't; `lossy` means one of the
 * two files EXISTS but the result does not fully represent it (unreadable,
 * unparsable, entries skipped, or validation failed). Mutators must refuse to
 * write while a read is lossy — writing back would silently destroy the
 * entries we skipped.
 */
export interface RegistryReadResult {
    registry: StoreRegistry | null;
    problems: string[];
    lossy: boolean;
}
export declare function readStoreRegistryDetailed(phrenPath: string): RegistryReadResult;
export declare function readStoreRegistry(phrenPath: string): StoreRegistry | null;
/**
 * Writes this machine's view of the stores: the primary entry to the synced
 * stores.yaml (only when it changed) and every other store to the machine's
 * own attached-stores.yaml.
 */
export declare function writeStoreRegistry(phrenPath: string, registry: StoreRegistry): void;
/** True when a store's directory exists on this machine. */
export declare function storePathExists(storePath: string): boolean;
/**
 * Resolve the full list of stores on this machine. This is the **key
 * backward-compat function**:
 * - The primary comes from the synced stores.yaml, or is implicit when the
 *   file is missing
 * - Then every store attached on this machine (.runtime/attached-stores.yaml)
 * - Then PHREN_FEDERATION_PATHS entries as readonly stores
 *
 * Every returned entry carries `available`, recording whether its path exists
 * here. Attached stores whose folder is gone are deliberately **still
 * returned**: callers must be able to see that a store claims a project before
 * deciding what to do, otherwise its writes would land in the primary store.
 */
export declare function resolveAllStores(phrenPath: string): StoreEntry[];
/**
 * Non-primary entries in the synced stores.yaml that this machine does not use:
 * joined on another machine with an older phren. Attached ones were moved into
 * attached-stores.yaml; the rest mean nothing here.
 */
export declare function ignoredSyncedStores(phrenPath: string): StoreEntry[];
/** Stores attached on this machine whose directory is missing. */
export declare function getUnavailableStores(phrenPath: string): StoreEntry[];
/**
 * One actionable sentence about a store attached on this machine whose folder
 * is gone. Shared by write routing, `phren status`, and `phren doctor` so all
 * three name the same store, the same expected path, and the same remedy.
 */
export declare function describeUnavailableStore(store: StoreEntry): string;
/** The primary store (role=primary). Falls back to implicit entry. */
export declare function getPrimaryStore(phrenPath: string): StoreEntry;
/** All stores that can be read (all roles). */
export declare function getReadableStores(phrenPath: string): StoreEntry[];
/** Non-primary stores (for federation search, multi-store sync). */
export declare function getNonPrimaryStores(phrenPath: string): StoreEntry[];
/** Find a store by name. */
export declare function findStoreByName(phrenPath: string, name: string): StoreEntry | undefined;
/** Get project directories for a store, filtered by the store's subscription list (if set). */
export declare function getStoreProjectDirs(store: StoreEntry): string[];
export declare function readTeamBootstrap(storePath: string): TeamBootstrap | null;
/** Attach a store on this machine. Creates stores.yaml for the primary if needed. Uses file locking. */
export declare function addStoreToRegistry(phrenPath: string, entry: StoreEntry): void;
/** Remove a store entry by name. Refuses to remove primary. Uses file locking. */
export declare function removeStoreFromRegistry(phrenPath: string, name: string): StoreEntry;
/** Update the projects[] claim list for a store. Uses file locking. */
export declare function updateStoreProjects(phrenPath: string, storeName: string, projects: string[]): void;
/** Add projects to a store's subscription list. Deduplicates. Uses file locking. */
export declare function subscribeStoreProjects(phrenPath: string, storeName: string, projects: string[]): void;
/** Remove projects from a store's subscription list. Uses file locking. */
export declare function unsubscribeStoreProjects(phrenPath: string, storeName: string, projects: string[]): void;
