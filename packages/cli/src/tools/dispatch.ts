import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hookRequest } from "../bridge/client.js";
import { dispatchSchema } from "../bridge/dispatch.js";
import { mcpResponse } from "./types.js";

export function register(server: McpServer): void {
  server.registerTool("dispatch", {
    title: "◆ phren · dispatch",
    description: "Send a worker brief to an enrolled computer through the local Phren Hook. Returns a launch receipt and remote target, not a completion report. Never automatically retry an uncertain delivery.",
    inputSchema: dispatchSchema,
  }, async input => {
    try {
      const result = await hookRequest("/v1/dispatch", input, undefined, 180_000);
      return mcpResponse({ ok: result.ok === true, data: result, message: `${result.computer}: ${result.state}.` });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Dispatch failed." });
    }
  });
}
