import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface McpContext {
  cortexPath: string;
  profile: string;
  db: () => any;
  rebuildIndex: () => Promise<void>;
  withWriteQueue: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type RegisterFn = (server: McpServer, ctx: McpContext) => void;
