import type { SqlJsDatabase } from "../shared/index.js";
import { parseStoreQualified } from "../store-routing.js";
import { resolveAllStores } from "../store-registry.js";

export interface McpContext {
  phrenPath: string;
  profile: string;
  db: () => SqlJsDatabase;
  rebuildIndex: () => Promise<void>;
  updateFileInIndex: (filePath: string) => void;
  withWriteQueue: <T>(fn: () => Promise<T>) => Promise<T | { content: { type: "text"; text: string }[] }>;
}

/**
 * Resolve the effective phrenPath and bare project name for a project input.
 * Handles store-qualified names ("store/project") by routing to the correct store.
 * Returns the primary store path for bare names.
 */
export function resolveStoreForProject(
  ctx: McpContext,
  projectInput: string,
): { phrenPath: string; project: string; storeRole: string } {
  const { storeName, projectName } = parseStoreQualified(projectInput);

  if (!storeName) {
    return { phrenPath: ctx.phrenPath, project: projectName, storeRole: "primary" };
  }

  const stores = resolveAllStores(ctx.phrenPath);
  const store = stores.find((s) => s.name === storeName);
  if (!store) {
    throw new Error(`Store "${storeName}" not found`);
  }
  if (store.role === "readonly") {
    throw new Error(`Store "${storeName}" is read-only`);
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
