import type { AgentTool, AgentToolResult } from "./types.js";
import type { McpConnection } from "../mcp-client.js";

/**
 * Create MCP resource tools that are wired to live server connections.
 * When no connections exist, the tools return a helpful message.
 */
export function createMcpResourceTools(getConnections: () => McpConnection[]): AgentTool[] {
  return [createListMcpResourcesTool(getConnections), createReadMcpResourceTool(getConnections)];
}

function createListMcpResourcesTool(getConnections: () => McpConnection[]): AgentTool {
  return {
    name: "list_mcp_resources",
    description:
      "List available resources from connected MCP servers. Resources are data endpoints that servers expose (database tables, config files, etc.).",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Optional: filter by server name." },
      },
    },
    async execute(input: Record<string, unknown>): Promise<AgentToolResult> {
      const connections = getConnections();
      if (connections.length === 0) {
        return { output: "No MCP server connections available. Connect MCP servers with --mcp-config to use resources." };
      }

      const serverFilter = typeof input.server === "string" ? input.server : undefined;
      const results: string[] = [];

      for (const conn of connections) {
        if (serverFilter && conn.name !== serverFilter) continue;
        try {
          const resources = await conn.listResources();
          if (resources.length === 0) {
            results.push(`${conn.name}: no resources`);
          } else {
            const lines = resources.map((r) => `  - ${r.uri}${r.name ? ` (${r.name})` : ""}${r.description ? `: ${r.description}` : ""}`);
            results.push(`${conn.name}:\n${lines.join("\n")}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`${conn.name}: error listing resources — ${msg}`);
        }
      }

      return { output: results.join("\n\n") || "No matching servers found." };
    },
  };
}

function createReadMcpResourceTool(getConnections: () => McpConnection[]): AgentTool {
  return {
    name: "read_mcp_resource",
    description: "Read a specific resource from an MCP server by URI.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name." },
        uri: { type: "string", description: "Resource URI to read." },
      },
      required: ["server", "uri"],
    },
    async execute(input: Record<string, unknown>): Promise<AgentToolResult> {
      const connections = getConnections();
      const serverName = String(input.server ?? "");
      const uri = String(input.uri ?? "");

      if (!serverName || !uri) {
        return { output: "Both 'server' and 'uri' parameters are required.", is_error: true };
      }

      const conn = connections.find((c) => c.name === serverName);
      if (!conn) {
        const available = connections.map((c) => c.name).join(", ") || "none";
        return { output: `Server "${serverName}" not found. Available: ${available}`, is_error: true };
      }

      try {
        const result = await conn.readResource(uri);
        return { output: result };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Failed to read resource "${uri}" from ${serverName}: ${msg}`, is_error: true };
      }
    },
  };
}
