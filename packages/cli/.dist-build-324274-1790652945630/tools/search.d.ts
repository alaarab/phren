import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext } from "./types.js";
/**
 * Q30: Log zero-result queries to .runtime/search-misses.jsonl.
 * Strips PII-like tokens (emails, UUIDs, numbers) and keeps only query terms.
 */
export declare function logSearchMiss(phrenPath: string, query: string, project?: string): void;
export declare function register(server: McpServer, ctx: McpContext): void;
