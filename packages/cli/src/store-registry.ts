import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import * as yaml from "js-yaml";
import { expandHomePath, atomicWriteText, runtimeDir } from "./phren-paths.js";
import { withFileLock } from "./governance/locks.js";
import { isRecord, loadYamlDocument, PhrenError } from "./phren-core.js";
import { getProjectDirs } from "./shared.js";

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * The synced registry at the store root. It holds the primary store's entry
 * only, so every machine on this personal store agrees on its id. Team and
 * readonly stores used to live here too, which pushed one machine's `team
 * join` onto every other machine and left doctor failing forever there.
 */
export const STORES_FILENAME = "stores.yaml";
/**
 * The stores attached on this machine, under `.runtime/` (never synced).
 * Using the personal store must never connect a machine to a team store.
 */
export const ATTACHED_STORES_FILENAME = "attached-stores.yaml";
const TEAM_BOOTSTRAP_FILENAME = ".phren-team.yaml";
const VALID_ROLES: ReadonlySet<string> = new Set(["primary", "team", "readonly"]);
const VALID_SYNC_MODES: ReadonlySet<string> = new Set(["managed-git", "pull-only"]);

// ── Path helpers ─────────────────────────────────────────────────────────────

export function storesFilePath(phrenPath: string): string {
  return path.join(phrenPath, STORES_FILENAME);
}

export function attachedStoresFilePath(phrenPath: string): string {
  return path.join(runtimeDir(phrenPath), ATTACHED_STORES_FILENAME);
}

// ── ID generation ────────────────────────────────────────────────────────────

export function generateStoreId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * Deterministic ID from a filesystem path — used for PHREN_FEDERATION_PATHS
 * backward-compat entries so the same path always produces the same ID.
 */
function deterministicIdFromPath(storePath: string): string {
  return crypto.createHash("sha256").update(storePath).digest("hex").slice(0, 8);
}

// ── Read / Write ─────────────────────────────────────────────────────────────

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

export function readStoreRegistryDetailed(phrenPath: string): RegistryReadResult {
  const synced = readSyncedRegistry(phrenPath);
  const attached = readAttachedStores(phrenPath, synced.registry);
  const problems = [...synced.problems, ...attached.problems];
  const lossy = synced.lossy || attached.lossy;
  if (!synced.registry && attached.stores.length === 0) return { registry: null, problems, lossy };

  const primary = synced.registry?.stores.find((s) => s.role === "primary") ?? implicitPrimaryStore(phrenPath);
  const registry: StoreRegistry = { version: 1, stores: [primary, ...attached.stores] };
  const err = validateRegistry(registry);
  if (err) {
    problems.push(`${ATTACHED_STORES_FILENAME} failed validation: ${err}`);
    return { registry: synced.registry ? { version: 1, stores: [primary] } : null, problems, lossy: true };
  }
  return { registry, problems, lossy };
}

/** The synced stores.yaml as written, including entries this machine ignores. */
function readSyncedRegistry(phrenPath: string): RegistryReadResult {
  const parsed = readYamlFile(storesFilePath(phrenPath), STORES_FILENAME);
  if (!parsed.exists || parsed.problems.length > 0) {
    return { registry: null, problems: parsed.problems, lossy: parsed.exists };
  }

  const problems: string[] = [];
  const { registry, skippedEntries } = normalizeRegistry(parsed.value, problems, STORES_FILENAME);
  if (!registry) {
    return { registry: null, problems, lossy: true };
  }

  // Validate on read too — reject malformed registries before they reach hooks/sync
  const err = validateRegistry(registry);
  if (err) {
    problems.push(`${STORES_FILENAME} failed validation: ${err}`);
    return { registry: null, problems, lossy: true };
  }

  return { registry, problems, lossy: skippedEntries > 0 };
}

interface AttachedStoresRead {
  stores: StoreEntry[];
  problems: string[];
  lossy: boolean;
}

function readAttachedStores(phrenPath: string, synced: StoreRegistry | null): AttachedStoresRead {
  const parsed = readYamlFile(attachedStoresFilePath(phrenPath), ATTACHED_STORES_FILENAME);
  if (!parsed.exists) return { stores: migrateSyncedAttachments(phrenPath, synced), problems: [], lossy: false };
  if (parsed.problems.length > 0) return { stores: [], problems: parsed.problems, lossy: true };

  const problems: string[] = [];
  const { registry, skippedEntries } = normalizeRegistry(parsed.value, problems, ATTACHED_STORES_FILENAME, true);
  if (!registry) return { stores: [], problems, lossy: true };
  const stores = registry.stores.filter((s) => s.role !== "primary");
  if (stores.length < registry.stores.length) {
    problems.push(`${ATTACHED_STORES_FILENAME}: the primary store belongs in ${STORES_FILENAME} — entry skipped.`);
  }
  return { stores, problems, lossy: skippedEntries > 0 || stores.length < registry.stores.length };
}

/**
 * One-time move from the old layout, where team stores were listed in the
 * synced stores.yaml. Only stores whose folder exists here were ever attached
 * on this machine; the rest came from another machine and are dropped. The
 * synced file is left as it is: machines still on an older phren read it.
 */
function migrateSyncedAttachments(phrenPath: string, synced: StoreRegistry | null): StoreEntry[] {
  const listed = synced?.stores.filter((s) => s.role !== "primary") ?? [];
  if (listed.length === 0) return [];
  const attached = listed.filter((s) => storePathExists(s.path));
  try {
    writeAttachedStores(phrenPath, attached);
  } catch (err) {
    // Still honor them for this read; the next read retries the move.
    console.warn(`phren: could not write ${attachedStoresFilePath(phrenPath)}: ${String(err)}`);
  }
  return attached;
}

function readYamlFile(filePath: string, label: string): { exists: boolean; value?: unknown; problems: string[] } {
  if (!fs.existsSync(filePath)) return { exists: false, problems: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { exists: true, problems: [`${label} is unreadable: ${String(err)}`] };
  }
  try {
    return { exists: true, value: loadYamlDocument(raw, (text) => yaml.load(text, { schema: yaml.CORE_SCHEMA })), problems: [] };
  } catch (err) {
    return { exists: true, problems: [`${label} is not valid YAML: ${String(err)}`] };
  }
}

/** Registry read problems already warned about, keyed by path + content. */
const warnedRegistryProblems = new Set<string>();

export function readStoreRegistry(phrenPath: string): StoreRegistry | null {
  const result = readStoreRegistryDetailed(phrenPath);
  if (result.problems.length > 0) {
    // Loud exactly once per process per distinct problem set: a malformed
    // stores.yaml used to be swallowed as "no registry", which silently
    // dropped every team store and re-routed their writes into the primary.
    const signature = `${phrenPath}\n${result.problems.join("\n")}`;
    if (!warnedRegistryProblems.has(signature)) {
      warnedRegistryProblems.add(signature);
      for (const problem of result.problems) {
        console.warn(`phren: ${problem}`);
      }
      if (!result.registry) {
        console.warn(
          `phren: ignoring ${storesFilePath(phrenPath)} and falling back to the primary store only — fix the file to restore multi-store routing.`
        );
      }
    }
  }
  return result.registry;
}

/**
 * Writes this machine's view of the stores: the primary entry to the synced
 * stores.yaml (only when it changed) and every other store to the machine's
 * own attached-stores.yaml.
 */
export function writeStoreRegistry(phrenPath: string, registry: StoreRegistry): void {
  const err = validateRegistry(registry);
  if (err) throw new Error(`${PhrenError.VALIDATION_ERROR}: ${err}`);

  writeSyncedPrimary(phrenPath, registry.stores.find((s) => s.role === "primary")!);
  writeAttachedStores(phrenPath, registry.stores.filter((s) => s.role !== "primary"));
}

function writeSyncedPrimary(phrenPath: string, primary: StoreEntry): void {
  const current = readSyncedRegistry(phrenPath);
  const existing = current.registry?.stores.find((s) => s.role === "primary");
  if (existing && sameEntry(existing, primary)) return;
  // Keep what older phren versions on other machines still list here.
  const others = current.lossy ? [] : current.registry?.stores.filter((s) => s.role !== "primary") ?? [];
  const portable: StoreRegistry = { version: 1, stores: [primary, ...others].map(portableEntry) };
  atomicWriteText(storesFilePath(phrenPath), yaml.dump(portable, { lineWidth: 200 }));
}

function writeAttachedStores(phrenPath: string, stores: StoreEntry[]): void {
  fs.mkdirSync(runtimeDir(phrenPath), { recursive: true });
  const portable = { version: 1, stores: stores.map(portableEntry) };
  atomicWriteText(attachedStoresFilePath(phrenPath), yaml.dump(portable, { lineWidth: 200 }));
}

/**
 * Collapse paths to a ~ prefix for portability. `available` is computed at
 * resolve time and is never written.
 */
function portableEntry({ available: _available, ...s }: StoreEntry): StoreEntry {
  return { ...s, path: collapsePath(s.path) };
}

function sameEntry(a: StoreEntry, b: StoreEntry): boolean {
  return a.id === b.id && a.name === b.name && a.path === b.path && a.role === b.role
    && a.sync === b.sync && a.remote === b.remote
    && (a.projects ?? []).join("\n") === (b.projects ?? []).join("\n");
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** True when a store's directory exists on this machine. */
export function storePathExists(storePath: string): boolean {
  try {
    return fs.statSync(storePath).isDirectory();
  } catch {
    return false;
  }
}

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
export function resolveAllStores(phrenPath: string): StoreEntry[] {
  const registry = readStoreRegistry(phrenPath);
  const stores: StoreEntry[] = registry ? [...registry.stores] : [implicitPrimaryStore(phrenPath)];

  // Append PHREN_FEDERATION_PATHS entries that aren't already in the registry
  const knownPaths = new Set(stores.map((s) => s.path));
  for (const fedPath of parseFederationPathsEnv(phrenPath)) {
    if (!knownPaths.has(fedPath)) {
      stores.push({
        id: deterministicIdFromPath(fedPath),
        name: path.basename(fedPath),
        path: fedPath,
        role: "readonly",
        sync: "pull-only",
      });
      knownPaths.add(fedPath);
    }
  }

  return stores.map((s) => ({ ...s, available: storePathExists(s.path) }));
}

/**
 * Non-primary entries in the synced stores.yaml that this machine does not use:
 * joined on another machine with an older phren. Attached ones were moved into
 * attached-stores.yaml; the rest mean nothing here.
 */
export function ignoredSyncedStores(phrenPath: string): StoreEntry[] {
  readStoreRegistry(phrenPath); // runs the one-time move first
  const synced = readSyncedRegistry(phrenPath).registry?.stores.filter((s) => s.role !== "primary") ?? [];
  const attached = new Set(resolveAllStores(phrenPath).map((s) => s.id));
  return synced.filter((s) => !attached.has(s.id));
}

/** Stores attached on this machine whose directory is missing. */
export function getUnavailableStores(phrenPath: string): StoreEntry[] {
  return resolveAllStores(phrenPath).filter((s) => s.available === false);
}

/**
 * One actionable sentence about a store attached on this machine whose folder
 * is gone. Shared by write routing, `phren status`, and `phren doctor` so all
 * three name the same store, the same expected path, and the same remedy.
 */
export function describeUnavailableStore(store: StoreEntry): string {
  const restore = store.remote ? `git clone ${store.remote} "${store.path}"` : `restore the folder`;
  return (
    `Store "${store.name}" (role=${store.role}) is attached on this machine but its folder is missing — ` +
    `expected path: ${store.path}. Either ${restore}, or detach it with: phren store remove ${store.name}`
  );
}

/** The primary store (role=primary). Falls back to implicit entry. */
export function getPrimaryStore(phrenPath: string): StoreEntry {
  const stores = resolveAllStores(phrenPath);
  return stores.find((s) => s.role === "primary") ?? implicitPrimaryStore(phrenPath);
}

/** All stores that can be read (all roles). */
export function getReadableStores(phrenPath: string): StoreEntry[] {
  return resolveAllStores(phrenPath);
}

/** Non-primary stores (for federation search, multi-store sync). */
export function getNonPrimaryStores(phrenPath: string): StoreEntry[] {
  return resolveAllStores(phrenPath).filter((s) => s.role !== "primary");
}

/** Find a store by name. */
export function findStoreByName(phrenPath: string, name: string): StoreEntry | undefined {
  return resolveAllStores(phrenPath).find((s) => s.name === name);
}

/** Get project directories for a store, filtered by the store's subscription list (if set). */
export function getStoreProjectDirs(store: StoreEntry): string[] {
  const allDirs = getProjectDirs(store.path);
  if (!store.projects || store.projects.length === 0) return allDirs;
  const allowed = new Set(store.projects);
  return allDirs.filter(dir => path.basename(dir) !== "global" && allowed.has(path.basename(dir)));
}

// ── Team bootstrap ───────────────────────────────────────────────────────────

export function readTeamBootstrap(storePath: string): TeamBootstrap | null {
  const filePath = path.join(storePath, TEAM_BOOTSTRAP_FILENAME);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = loadYamlDocument(raw, (text) => yaml.load(text, { schema: yaml.CORE_SCHEMA }));
    if (!isRecord(parsed) || typeof parsed.name !== "string") return null;
    return {
      name: parsed.name,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
      default_role: typeof parsed.default_role === "string" && isStoreRole(parsed.default_role)
        ? parsed.default_role
        : undefined,
    };
  } catch {
    return null;
  }
}

// ── Registry mutation helpers ────────────────────────────────────────────────

/**
 * A registry read that mutators are allowed to write back. A lossy read
 * (stores.yaml exists but was unreadable, unparsable, or had entries skipped)
 * must never round-trip through a writer: `addStoreToRegistry` used to treat
 * that null as "first install" and OVERWRITE the user's malformed-but-real
 * stores.yaml with a fresh single-store registry — one typo'd role plus one
 * `phren store add` silently destroyed every other store entry.
 */
function readRegistryForMutation(phrenPath: string): StoreRegistry | null {
  const result = readStoreRegistryDetailed(phrenPath);
  if (result.lossy) {
    throw new Error(
      `${PhrenError.VALIDATION_ERROR}: the store registry (${storesFilePath(phrenPath)} or ${attachedStoresFilePath(phrenPath)}) exists but could not be fully read — ` +
        `refusing to rewrite it (that would drop the entries phren cannot parse). ` +
        `Fix the file by hand first. Problems: ${result.problems.join(" | ")}`
    );
  }
  return result.registry;
}

/** Mutations change this machine's attachments, so they lock that file. */
function registryLockPath(phrenPath: string): string {
  fs.mkdirSync(runtimeDir(phrenPath), { recursive: true });
  return attachedStoresFilePath(phrenPath);
}

/** Attach a store on this machine. Creates stores.yaml for the primary if needed. Uses file locking. */
export function addStoreToRegistry(phrenPath: string, entry: StoreEntry): void {
  withFileLock(registryLockPath(phrenPath), () => {
    let registry = readRegistryForMutation(phrenPath);
    if (!registry) {
      // First time — also add the implicit primary store
      registry = { version: 1, stores: [implicitPrimaryStore(phrenPath)] };
    }

    const existing = registry.stores.find((s) => s.name === entry.name);
    if (existing) throw new Error(`${PhrenError.VALIDATION_ERROR}: Store "${entry.name}" already exists`);

    registry.stores.push(entry);
    writeStoreRegistry(phrenPath, registry);
  });
}

/** Remove a store entry by name. Refuses to remove primary. Uses file locking. */
export function removeStoreFromRegistry(phrenPath: string, name: string): StoreEntry {
  return withFileLock(registryLockPath(phrenPath), () => {
    const registry = readRegistryForMutation(phrenPath);
    if (!registry) throw new Error(`${PhrenError.FILE_NOT_FOUND}: No stores.yaml found`);

    const idx = registry.stores.findIndex((s) => s.name === name);
    if (idx === -1) throw new Error(`${PhrenError.NOT_FOUND}: Store "${name}" not found`);

    const entry = registry.stores[idx];
    if (entry.role === "primary") throw new Error(`${PhrenError.VALIDATION_ERROR}: Cannot remove the primary store`);

    registry.stores.splice(idx, 1);
    writeStoreRegistry(phrenPath, registry);
    return entry;
  });
}

/** Update the projects[] claim list for a store. Uses file locking. */
export function updateStoreProjects(phrenPath: string, storeName: string, projects: string[]): void {
  withFileLock(registryLockPath(phrenPath), () => {
    const registry = readRegistryForMutation(phrenPath);
    if (!registry) throw new Error(`${PhrenError.FILE_NOT_FOUND}: No stores.yaml found`);

    const store = registry.stores.find((s) => s.name === storeName);
    if (!store) throw new Error(`${PhrenError.NOT_FOUND}: Store "${storeName}" not found`);

    store.projects = projects.length > 0 ? projects : undefined;
    writeStoreRegistry(phrenPath, registry);
  });
}

/** Add projects to a store's subscription list. Deduplicates. Uses file locking. */
export function subscribeStoreProjects(phrenPath: string, storeName: string, projects: string[]): void {
  withFileLock(registryLockPath(phrenPath), () => {
    const registry = readRegistryForMutation(phrenPath);
    if (!registry) throw new Error(`${PhrenError.FILE_NOT_FOUND}: No stores.yaml found`);

    const store = registry.stores.find((s) => s.name === storeName);
    if (!store) throw new Error(`${PhrenError.NOT_FOUND}: Store "${storeName}" not found`);

    const existing = new Set(store.projects || []);
    for (const project of projects) {
      existing.add(project);
    }
    store.projects = Array.from(existing).sort().length > 0 ? Array.from(existing).sort() : undefined;
    writeStoreRegistry(phrenPath, registry);
  });
}

/** Remove projects from a store's subscription list. Uses file locking. */
export function unsubscribeStoreProjects(phrenPath: string, storeName: string, projects: string[]): void {
  withFileLock(registryLockPath(phrenPath), () => {
    const registry = readRegistryForMutation(phrenPath);
    if (!registry) throw new Error(`${PhrenError.FILE_NOT_FOUND}: No stores.yaml found`);

    const store = registry.stores.find((s) => s.name === storeName);
    if (!store) throw new Error(`${PhrenError.NOT_FOUND}: Store "${storeName}" not found`);

    const toRemove = new Set(projects);
    const remaining = (store.projects || []).filter((p) => !toRemove.has(p));
    store.projects = remaining.length > 0 ? remaining : undefined;
    writeStoreRegistry(phrenPath, registry);
  });
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateRegistry(registry: StoreRegistry): string | null {
  if (registry.version !== 1) return `Unsupported registry version: ${registry.version}`;
  if (!Array.isArray(registry.stores) || registry.stores.length === 0) return "Registry must have at least one store";

  const names = new Set<string>();
  const ids = new Set<string>();
  for (const store of registry.stores) {
    if (!store.id || typeof store.id !== "string") return `Store missing id`;
    if (!store.name || typeof store.name !== "string") return `Store missing name`;
    if (!store.path || typeof store.path !== "string") return `Store "${store.name}" missing path`;
    if (!isStoreRole(store.role)) return `Store "${store.name}" has invalid role: ${store.role}`;
    if (!isStoreSyncMode(store.sync)) return `Store "${store.name}" has invalid sync mode: ${store.sync}`;
    if (names.has(store.name)) return `Duplicate store name: "${store.name}"`;
    if (ids.has(store.id)) return `Duplicate store id: "${store.id}"`;
    names.add(store.name);
    ids.add(store.id);
  }

  const primaryCount = registry.stores.filter((s) => s.role === "primary").length;
  if (primaryCount !== 1) return `Registry must have exactly one primary store (found ${primaryCount})`;

  return null;
}

// ── Normalization ────────────────────────────────────────────────────────────

/** Aliases accepted on read for role values other tools/humans plausibly write. */
const ROLE_ALIASES: Readonly<Record<string, StoreRole>> = { secondary: "team" };

/**
 * One bad entry used to discard the ENTIRE registry (`return null` mid-loop),
 * with nothing logged — a single typo'd role silently dropped every team
 * store. Now each invalid entry is skipped with a reason pushed to
 * `problems`, and the valid remainder is kept. Callers see `skippedEntries`
 * so mutators can refuse to persist a lossy read.
 */
function normalizeRegistry(
  parsed: unknown,
  problems: string[],
  label: string,
  allowEmpty = false
): { registry: StoreRegistry | null; skippedEntries: number } {
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.stores)) {
    problems.push(
      `${label} has an unrecognized shape (expected \`version: 1\` and a \`stores:\` list).`
    );
    return { registry: null, skippedEntries: 0 };
  }

  const stores: StoreEntry[] = [];
  let skippedEntries = 0;
  for (const [index, raw] of parsed.stores.entries()) {
    const skip = (entry: string, reason: string): void => {
      skippedEntries += 1;
      problems.push(`${label}: store ${entry} ${reason} — entry skipped.`);
    };

    if (!isRecord(raw)) {
      skip(`#${index + 1}`, "is not a mapping");
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id : "";
    const name = typeof raw.name === "string" ? raw.name : "";
    const entryLabel = name ? `"${name}"` : `#${index + 1}`;
    const rawPath = typeof raw.path === "string" ? raw.path : "";
    const rawRole = typeof raw.role === "string" ? raw.role : "";
    const aliasedRole = ROLE_ALIASES[rawRole];
    if (aliasedRole) {
      problems.push(
        `${label}: store ${entryLabel} has role "${rawRole}" — reading it as "${aliasedRole}" (valid roles: primary|team|readonly).`
      );
    }
    const roleValue = aliasedRole ?? rawRole;
    const role = isStoreRole(roleValue) ? roleValue : null;
    const sync = typeof raw.sync === "string" && isStoreSyncMode(raw.sync) ? raw.sync : "managed-git";
    const remote = typeof raw.remote === "string" ? raw.remote : undefined;
    const projects = Array.isArray(raw.projects)
      ? raw.projects.filter((p): p is string => typeof p === "string")
      : undefined;

    if (!id || !name || !rawPath || !role) {
      const missing = [
        !id && "id",
        !name && "name",
        !rawPath && "path",
        !role && `a valid role (got "${rawRole || "(none)"}")`,
      ].filter(Boolean);
      skip(entryLabel, `is missing ${missing.join(", ")}`);
      continue;
    }

    stores.push({
      id,
      name,
      path: path.resolve(expandHomePath(rawPath)),
      role,
      sync,
      remote,
      projects: projects && projects.length > 0 ? projects : undefined,
    });
  }

  if (stores.length === 0 && !allowEmpty) {
    problems.push(`${label} contains no usable store entries.`);
    return { registry: null, skippedEntries };
  }
  return { registry: { version: 1, stores }, skippedEntries };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function implicitPrimaryStore(phrenPath: string): StoreEntry {
  return {
    id: deterministicIdFromPath(phrenPath),
    name: "personal",
    path: phrenPath,
    role: "primary",
    sync: "managed-git",
  };
}

function parseFederationPathsEnv(localPhrenPath: string): string[] {
  const raw = process.env.PHREN_FEDERATION_PATHS ?? "";
  if (!raw.trim()) return [];
  // Use path.delimiter (';' on Windows, ':' on Unix) so Windows drive letters aren't split
  return raw
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => path.resolve(expandHomePath(p)))
    .filter((p) => p !== localPhrenPath && fs.existsSync(p));
}

function isStoreRole(value: string): value is StoreRole {
  return VALID_ROLES.has(value);
}

function isStoreSyncMode(value: string): value is StoreSyncMode {
  return VALID_SYNC_MODES.has(value);
}

function collapsePath(absPath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && absPath.startsWith(home + path.sep)) {
    return "~/" + absPath.slice(home.length + 1);
  }
  return absPath;
}
