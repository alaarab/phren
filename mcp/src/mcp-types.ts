import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SqlJsDatabase } from "./shared-index.js";

export interface McpContext {
  cortexPath: string;
  profile: string;
  db: () => SqlJsDatabase;
  rebuildIndex: () => Promise<void>;
  updateFileInIndex: (filePath: string) => void;
  withWriteQueue: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type RegisterFn = (server: McpServer, ctx: McpContext) => void;

/**
 * Standardized MCP tool response payload, based on CortexResult conventions.
 * - ok: true  → data is present, message is optional display text
 * - ok: false → error is present, data may carry diagnostic info
 *
 * Accepts `boolean` for ok (not just literals) to support computed expressions
 * like `ok: added.length > 0`. All MCP tool handlers use this type.
 */
export interface McpToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

/**
 * Convert an McpToolResult into the MCP SDK response format.
 * Single shared implementation — replaces the per-file jsonResponse() duplicates.
 */
export function mcpResponse(payload: McpToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
