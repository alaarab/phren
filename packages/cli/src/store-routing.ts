import * as fs from "fs";
import * as path from "path";
import { getProjectDirs } from "./phren-paths.js";
import { PhrenError } from "./phren-core.js";
import { isValidProjectName } from "./utils.js";
import { resolveAllStores, type StoreEntry } from "./store-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResolvedProject {
  store: StoreEntry;
  projectName: string;
  projectDir: string;
}

export interface ParsedProjectRef {
  storeName?: string;
  projectName: string;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a project reference that may be store-qualified.
 *
 * "arc"          → { projectName: "arc" }
 * "arc-team/arc" → { storeName: "arc-team", projectName: "arc" }
 */
export function parseStoreQualified(input: string): ParsedProjectRef {
  const trimmed = input.trim();
  const slashIdx = trimmed.indexOf("/");

  if (slashIdx === -1) {
    return { projectName: trimmed };
  }

  const storeName = trimmed.slice(0, slashIdx);
  const projectName = trimmed.slice(slashIdx + 1);

  // Only treat as store-qualified if both parts are valid names
  if (storeName && projectName && !projectName.includes("/")) {
    return { storeName, projectName };
  }

  // Malformed — treat whole thing as project name (will fail validation later)
  return { projectName: trimmed };
}

// ── Resolution ───────────────────────────────────────────────────────────────

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
export function resolveProject(
  phrenPath: string,
  input: string,
  profile?: string,
): ResolvedProject {
  const { storeName, projectName } = parseStoreQualified(input);

  if (!isValidProjectName(projectName)) {
    throw new Error(`${PhrenError.VALIDATION_ERROR}: Invalid project name: "${projectName}"`);
  }

  if (storeName && !isValidStoreName(storeName)) {
    throw new Error(`${PhrenError.VALIDATION_ERROR}: Invalid store name: "${storeName}"`);
  }

  const stores = resolveAllStores(phrenPath);

  // Store-qualified: find exact store
  if (storeName) {
    const store = stores.find((s) => s.name === storeName);
    if (!store) {
      const available = stores.map((s) => s.name).join(", ");
      throw new Error(`${PhrenError.NOT_FOUND}: Store "${storeName}" not found. Available: ${available}`);
    }

    const projectDir = findProjectInStore(store, projectName, profile);
    if (!projectDir) {
      throw new Error(`${PhrenError.NOT_FOUND}: Project "${projectName}" not found in store "${storeName}"`);
    }

    return { store, projectName, projectDir };
  }

  // Bare project: scan all stores
  const matches: ResolvedProject[] = [];
  for (const store of stores) {
    const projectDir = findProjectInStore(store, projectName, profile);
    if (projectDir) {
      matches.push({ store, projectName, projectDir });
    }
  }

  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    throw new Error(`${PhrenError.NOT_FOUND}: Project "${projectName}" not found in any store`);
  }

  // Ambiguous — multiple stores have this project
  const storeNames = matches.map((m) => `${m.store.name}/${projectName}`).join(", ");
  throw new Error(
    `${PhrenError.VALIDATION_ERROR}: Project "${projectName}" exists in multiple stores. ` +
    `Use store-qualified name to disambiguate: ${storeNames}`,
  );
}

/**
 * List all projects across all readable stores.
 * Returns entries with store context for display.
 */
export function listAllProjects(
  phrenPath: string,
  profile?: string,
): Array<{ store: StoreEntry; projectName: string; projectDir: string }> {
  const stores = resolveAllStores(phrenPath);
  const results: Array<{ store: StoreEntry; projectName: string; projectDir: string }> = [];

  for (const store of stores) {
    const dirs = getProjectDirs(store.path, store.role === "primary" ? profile : undefined);
    for (const dir of dirs) {
      const projectName = path.basename(dir);
      results.push({ store, projectName, projectDir: dir });
    }
  }

  return results;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const STORE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function isValidStoreName(name: string): boolean {
  return STORE_NAME_PATTERN.test(name);
}

function findProjectInStore(
  store: StoreEntry,
  projectName: string,
  profile?: string,
): string | null {
  if (!fs.existsSync(store.path)) return null;

  const dirs = getProjectDirs(store.path, store.role === "primary" ? profile : undefined);
  for (const dir of dirs) {
    if (path.basename(dir) === projectName) return dir;
  }

  return null;
}
