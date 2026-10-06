import { homeDir } from "./home-paths.js";
export type InstallMode = "shared" | "project-local";
export type SyncMode = "managed-git" | "workspace-git";
export interface PhrenRootManifest {
    version: 1;
    installMode: InstallMode;
    syncMode: SyncMode;
    workspaceRoot?: string;
    primaryProject?: string;
}
export interface InstallContext extends PhrenRootManifest {
    phrenPath: string;
}
export declare const ROOT_MANIFEST_FILENAME = "phren.root.yaml";
export { homeDir };
export declare function homePath(...parts: string[]): string;
export declare function expandHomePath(input: string): string;
export declare function defaultPhrenPath(): string;
export declare function rootManifestPath(phrenPath: string): string;
export interface AtomicWriteOptions {
    /**
     * POSIX mode for the written file, applied to the temp file *before* the
     * rename. Callers writing secrets must pass this rather than chmod-ing after
     * the fact: a post-rename chmod leaves the file readable at the default
     * umask-derived mode (0644 on a stock install) for the whole write window,
     * which is exactly long enough for another local user to read it.
     */
    mode?: number;
}
export declare function atomicWriteText(filePath: string, content: string | Uint8Array, opts?: AtomicWriteOptions): void;
/**
 * Create (or tighten) a directory that holds per-user private data — runtime
 * logs, session transcripts, credential stores.
 *
 * Plain `fs.mkdirSync(dir, { recursive: true })` yields 0755 under the stock
 * 0022 umask, which makes every file inside world-listable and world-readable
 * on a shared machine. Passing `mode` to mkdirSync is not enough on its own:
 * mkdirSync's mode applies only to directories it actually *creates*, so a
 * directory that some earlier code path already made at 0755 keeps that mode
 * forever. That is not hypothetical — `runtimeFile()` created `~/.phren/.runtime`
 * with no mode long before `auth/profiles.ts` ever asked for 0700, so the
 * credential directory shipped world-readable in practice.
 *
 * Only ever narrows: if the directory is already 0700 or tighter it is left
 * alone. Best-effort — a chmod failure (foreign filesystem, Windows) must not
 * break the caller, since the directory itself is usable either way.
 */
export declare function ensurePrivateDir(dir: string): string;
export declare function isInstallMode(value: unknown): value is InstallMode;
export declare function readRootManifest(phrenPath: string): PhrenRootManifest | null;
export declare function writeRootManifest(phrenPath: string, manifest: PhrenRootManifest): void;
export declare function resolveInstallContext(phrenPath: string): InstallContext;
export declare function findNearestPhrenPath(startDir?: string): string | null;
export declare function findPhrenPath(): string | null;
export declare function ensurePhrenPath(): string;
export declare function findPhrenPathWithArg(arg?: string): string;
export declare function isProjectLocalMode(phrenPath: string): boolean;
export declare function runtimeDir(phrenPath: string): string;
/** Unlink a file, ignoring ENOENT. Rethrows any other error. */
export declare function tryUnlink(filePath: string): void;
export declare function sessionsDir(phrenPath: string): string;
export declare function runtimeFile(phrenPath: string, name: string): string;
/**
 * Per-user root for the FTS snapshot cache: `os.tmpdir()/phren-fts-<uid>`.
 *
 * Canonical definition of the path lives here, with every other phren path
 * helper. `shared/index.ts` currently has its own private copy — see
 * ensureFtsCacheRootPrivate() for why that matters and what still needs to
 * change there.
 */
export declare function ftsCacheRoot(): string;
/**
 * Make the FTS snapshot cache root private, creating it if needed.
 *
 * The snapshot is a SQLite export of the *entire* indexed store — the full
 * text of every finding, note, task and reference doc. It was being written
 * as an 0644 file inside an 0755 directory:
 *
 *   drwxr-xr-x  $TMPDIR/phren-fts-501
 *   -rw-r--r--  $TMPDIR/phren-fts-501/<storeKey>/<hash>.db
 *
 * On macOS `os.tmpdir()` is a per-user `/var/folders/…/T` at 0700, which is
 * the only reason this is not already a leak there. On Linux and WSL
 * `os.tmpdir()` is `/tmp` — mode 1777, world-readable — so any local account
 * can read another user's whole knowledge base. phren ships cross-platform on
 * npm, so that is a live exposure, not a theoretical one.
 *
 * A 0700 root closes it completely: POSIX denies traversal into the directory,
 * so the modes of the per-store subdirectory and the .db files inside it stop
 * being reachable at all. Called once per process from the CLI and MCP-server
 * entrypoints, which both creates it correctly on a clean machine and repairs
 * the 0755 root on machines that already have one.
 *
 * Still worth doing for defence in depth, in the file that actually writes
 * them: `shared/index.ts` should pass `{ recursive: true, mode: 0o700 }` to
 * the `fs.mkdirSync(cacheDir, …)` calls and `{ mode: 0o600 }` to the
 * `fs.writeFileSync(cacheFile, db.export())` calls. That file is owned by
 * another change in flight, so it is reported rather than edited here.
 */
export declare function ensureFtsCacheRootPrivate(): string;
export declare function installPreferencesFile(phrenPath: string): string;
export declare function runtimeHealthFile(phrenPath: string): string;
export declare function shellStateFile(phrenPath: string): string;
export declare function sessionMetricsFile(phrenPath: string): string;
export declare function memoryScoresFile(phrenPath: string): string;
export declare function memoryUsageLogFile(phrenPath: string): string;
/**
 * Live "lookup events" log: one JSONL entry per memory a search lands on.
 * Distinct from memory-usage.log (injection scoring) — this feed powers the
 * real-time activity surfaces in the web UI and the VS Code extension.
 */
export declare function lookupEventsLogFile(phrenPath: string): string;
export declare function sessionMarker(phrenPath: string, name: string): string;
export declare function debugLog(msg: string): void;
/** Always-on structured error log (no PHREN_DEBUG gate). */
export declare function errorLog(tool: string, msg: string): void;
/**
 * Truncate an append-only .jsonl to its last `keepLines` lines once it exceeds
 * `maxBytes`. Best-effort: any IO error (including ENOENT) is ignored so callers
 * never fail on rotation.
 */
export declare function rotateJsonlIfLarge(filePath: string, maxBytes?: number, keepLines?: number): void;
export declare function appendIndexEvent(phrenPath: string, event: Record<string, unknown>): void;
/** Resolve the canonical findings file for a project directory. */
export declare function resolveFindingsPath(projectDir: string): string | undefined;
export declare function listInvalidProjectDirs(phrenPath: string): string[];
export declare function normalizeProjectNameForCreate(name: string): string;
/**
 * The single source of truth for turning a source directory into a project
 * slug. Previously copy-pasted at five call sites, which is how the same repo
 * could end up registered twice under near-identical names.
 *
 * Runs of non-slug characters collapse to one hyphen and leading/trailing
 * hyphens are trimmed, so `My.App`, `My..App` and `My App` all yield `my-app`
 * instead of the old `my-app` / `my--app` / `my-app` split.
 */
export declare function projectSlugFromPath(sourcePath: string): string;
/**
 * Collapse a project name to the key used for duplicate detection: lowercase
 * with every separator removed. `Max4LivePlugins`, `max4liveplugins` and
 * `max4live-plugins` all map to `max4liveplugins`, so the second spelling of a
 * repo can be recognized as the project that already exists.
 */
export declare function canonicalProjectKey(name: string): string;
export declare function findProjectNameCaseInsensitive(phrenPath: string, name: string): string | null;
/**
 * Existing project directories whose name canonicalizes to the same key as
 * `name` (see {@link canonicalProjectKey}). Exact matches are returned first so
 * callers can prefer them.
 */
export declare function findProjectNamesByCanonicalKey(phrenPath: string, name: string): string[];
export declare function findArchivedProjectNameCaseInsensitive(phrenPath: string, name: string): string | null;
export declare function getProjectDirs(phrenPath: string, profile?: string): string[];
/** Claude's own memory directory is indexed only when asked: by default phren indexes phren. */
export declare function nativeMemoryEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function collectNativeMemoryFiles(): Array<{
    project: string;
    file: string;
    fullPath: string;
}>;
export declare function computePhrenLiveStateToken(phrenPath: string): string;
export declare function getPhrenPath(): string;
export declare function qualityMarkers(phrenPathLocal: string): {
    done: string;
    lock: string;
};
