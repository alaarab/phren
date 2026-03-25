import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import * as yaml from "js-yaml";
import { expandHomePath, atomicWriteText } from "./phren-paths.js";
import { withFileLock } from "./governance/locks.js";
import { isRecord, PhrenError } from "./phren-core.js";

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

const STORES_FILENAME = "stores.yaml";
const TEAM_BOOTSTRAP_FILENAME = ".phren-team.yaml";
const VALID_ROLES: ReadonlySet<string> = new Set(["primary", "team", "readonly"]);
const VALID_SYNC_MODES: ReadonlySet<string> = new Set(["managed-git", "pull-only"]);

// ── Path helpers ─────────────────────────────────────────────────────────────

export function storesFilePath(phrenPath: string): string {
  return path.join(phrenPath, STORES_FILENAME);
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

export function readStoreRegistry(phrenPath: string): StoreRegistry | null {
  const filePath = storesFilePath(phrenPath);
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
  } catch {
    return null;
  }
  const registry = normalizeRegistry(parsed);
  if (!registry) return null;

  // Validate on read too — reject malformed registries before they reach hooks/sync
  const err = validateRegistry(registry);
  if (err) return null;

  return registry;
}

export function writeStoreRegistry(phrenPath: string, registry: StoreRegistry): void {
  const err = validateRegistry(registry);
  if (err) throw new Error(`${PhrenError.VALIDATION_ERROR}: ${err}`);

  // Collapse paths to ~ prefix for portability
  const portable: StoreRegistry = {
    version: 1,
    stores: registry.stores.map((s) => ({
      ...s,
      path: collapsePath(s.path),
    })),
  };

  atomicWriteText(storesFilePath(phrenPath), yaml.dump(portable, { lineWidth: 200 }));
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve the full list of stores. This is the **key backward-compat function**:
 * - If stores.yaml exists → parse and return entries
 * - If stores.yaml is missing → return a single implicit primary entry for phrenPath
 * - In both cases, append PHREN_FEDERATION_PATHS entries as readonly stores
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

  return stores;
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

// ── Team bootstrap ───────────────────────────────────────────────────────────

export function readTeamBootstrap(storePath: string): TeamBootstrap | null {
  const filePath = path.join(storePath, TEAM_BOOTSTRAP_FILENAME);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
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

/** Add a store entry to the registry. Creates stores.yaml if needed. Uses file locking. */
export function addStoreToRegistry(phrenPath: string, entry: StoreEntry): void {
  withFileLock(storesFilePath(phrenPath), () => {
    let registry = readStoreRegistry(phrenPath);
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
  return withFileLock(storesFilePath(phrenPath), () => {
    const registry = readStoreRegistry(phrenPath);
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

function normalizeRegistry(parsed: unknown): StoreRegistry | null {
  if (!isRecord(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (!Array.isArray(parsed.stores)) return null;

  const stores: StoreEntry[] = [];
  for (const raw of parsed.stores) {
    if (!isRecord(raw)) return null;
    const id = typeof raw.id === "string" ? raw.id : "";
    const name = typeof raw.name === "string" ? raw.name : "";
    const rawPath = typeof raw.path === "string" ? raw.path : "";
    const role = typeof raw.role === "string" && isStoreRole(raw.role) ? raw.role : null;
    const sync = typeof raw.sync === "string" && isStoreSyncMode(raw.sync) ? raw.sync : "managed-git";
    const remote = typeof raw.remote === "string" ? raw.remote : undefined;
    const projects = Array.isArray(raw.projects)
      ? raw.projects.filter((p): p is string => typeof p === "string")
      : undefined;

    if (!id || !name || !rawPath || !role) return null;

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

  if (stores.length === 0) return null;
  return { version: 1, stores };
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
  return raw
    .split(":")
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
