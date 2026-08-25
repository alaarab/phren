import type { SqlJsDatabase } from "../shared/index.js";
import { parseStoreQualified } from "../store-routing.js";
import { describeUnavailableStore, resolveAllStores, type StoreEntry } from "../store-registry.js";
import { logger } from "../logger.js";

export interface McpContext {
  phrenPath: string;
  profile: string;
  db: () => SqlJsDatabase;
  rebuildIndex: () => Promise<void>;
  updateFileInIndex: (filePath: string) => void;
  withWriteQueue: <T>(fn: () => Promise<T>) => Promise<T | { content: { type: "text"; text: string }[] }>;
}

/**
 * How the caller intends to use the resolved store.
 *
 * - `"write"` (default) — the resolution must be exact. If a store claims the
 *   project but is not attached on this machine, resolution **fails loudly**
 *   rather than silently redirecting the write somewhere else.
 * - `"read"` — the caller only reads. Missing team stores degrade to the
 *   primary store so search/list surfaces keep working offline; nothing leaves
 *   the machine, so a wrong answer here is a gap, not a leak.
 *
 * Defaulting to `"write"` is deliberate: an unclassified call site should get
 * the safe behavior, not the lossy one.
 */
export type StoreAccessMode = "read" | "write";

/**
 * Error raised when a project is claimed by a store that is declared in
 * stores.yaml but has no directory on this machine. Distinct class so callers
 * can special-case it if they ever want to offer an interactive fix.
 */
export class StoreUnavailableError extends Error {
  readonly storeName: string;
  readonly storePath: string;

  constructor(store: StoreEntry, project: string) {
    super(
      `Refusing to write "${project}": it belongs to a store that is not available here. ` +
      `${describeUnavailableStore(store)} ` +
      `Writing it to the primary store instead would copy ${store.role}-store data into your personal store, ` +
      `so phren stopped instead. Re-run once the store is attached, or use "phren team unsubscribe ${store.name} ${project}" ` +
      `if this project should no longer live there.`,
    );
    this.name = "StoreUnavailableError";
    this.storeName = store.name;
    this.storePath = store.path;
  }
}

/**
 * Resolve the effective phrenPath and bare project name for a project input.
 * Handles store-qualified names ("store/project") by routing to the correct store.
 * Returns the primary store path for bare names that no store claims.
 *
 * Note on the bare-name path: a store that claims the project but is missing
 * locally used to fall through to the primary store, which quietly relocated
 * team-store projects into the user's personal store. That fallback is gone for
 * writes — see {@link StoreAccessMode}.
 */
export function resolveStoreForProject(
  ctx: McpContext,
  projectInput: string,
  mode: StoreAccessMode = "write",
): { phrenPath: string; project: string; storeRole: string } {
  const { storeName, projectName } = parseStoreQualified(projectInput);
  const stores = resolveAllStores(ctx.phrenPath);

  if (!storeName) {
    // Check if any non-readonly store claims this project via projects[] array.
    // This enables automatic write routing: once a project is claimed by a team
    // store (via `phren team add-project`), writes go there without needing the
    // store-qualified prefix.
    const claiming = stores.find(
      (s) => s.role !== "readonly" && s.role !== "primary" && s.projects?.includes(projectName),
    );
    if (claiming) {
      if (claiming.available !== false) {
        return { phrenPath: claiming.path, project: projectName, storeRole: claiming.role };
      }
      if (mode === "write") throw new StoreUnavailableError(claiming, projectName);
      logger.debug(
        "store-routing",
        `read for "${projectName}" fell back to primary: ${describeUnavailableStore(claiming)}`,
      );
    }
    return { phrenPath: ctx.phrenPath, project: projectName, storeRole: "primary" };
  }

  const store = stores.find((s) => s.name === storeName);
  if (!store) {
    throw new Error(`Store "${storeName}" not found`);
  }
  if (store.role === "readonly") {
    throw new Error(`Store "${storeName}" is read-only`);
  }
  // An explicitly named store has no defensible fallback — the caller asked for
  // that store by name, so say it isn't here rather than answering from another.
  if (store.available === false) {
    throw new StoreUnavailableError(store, projectName);
  }

  return { phrenPath: store.path, project: projectName, storeRole: store.role };
}

/**
 * Standardized MCP tool response payload, based on PhrenResult conventions.
 * - ok: true  → data is present, message is optional display text
 * - ok: false → error is present, data may carry diagnostic info
 *
 * Accepts `boolean` for ok (not just literals) to support computed expressions
 * like `ok: added.length > 0`. All MCP tool handlers use this type.
 */
interface McpToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
  message?: string;
}

/**
 * Convert an McpToolResult into the MCP SDK response format.
 * Single shared implementation — replaces the per-file jsonResponse() duplicates.
 */
export function mcpResponse(payload: McpToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
