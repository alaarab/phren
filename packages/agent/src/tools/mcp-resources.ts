import type { AgentTool } from "./types.js";
import { mcpRegistry } from "../mcp-client.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const listMcpResourcesTool: AgentTool = {
  name: "list_mcp_resources",
  description:
    "List available resources from connected MCP servers. Resources are data endpoints that servers expose (database tables, config files, etc.).",
  input_schema: {
    type: "object",
    properties: {
      server: { type: "string", description: "Optional: filter by server name." },
    },
  },
  async execute(input) {
    const server = typeof input.server === "string" && input.server ? input.server : undefined;
    const connected = mcpRegistry.listServers();
    if (connected.length === 0) {
      return { output: "No MCP servers connected. Connect one with --mcp-config or --mcp." };
    }
    try {
      const resources = await mcpRegistry.listResources(server);
      if (resources.length === 0) {
        return {
          output: server
            ? `MCP server "${server}" exposes no resources.`
            : "Connected MCP servers expose no resources.",
        };
      }
      const lines = resources.map((resource) => {
        const heading = `${resource.server}  ${resource.uri}${resource.name ? ` (${resource.name})` : ""}`;
        const meta = [resource.mimeType, resource.description].filter(Boolean).join(" — ");
        return meta ? `${heading}\n    ${meta}` : heading;
      });
      return { output: `MCP resources (${resources.length}):\n${lines.join("\n")}` };
    } catch (err: unknown) {
      return { output: `Failed to list MCP resources: ${errorMessage(err)}`, is_error: true };
    }
  },
};

export const readMcpResourceTool: AgentTool = {
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
  async execute(input) {
    const server = typeof input.server === "string" ? input.server : "";
    const uri = typeof input.uri === "string" ? input.uri : "";
    if (!server) return { output: "read_mcp_resource requires a server name.", is_error: true };
    if (!uri) return { output: "read_mcp_resource requires a resource uri.", is_error: true };
    try {
      const contents = await mcpRegistry.readResource(server, uri);
      if (contents.length === 0) return { output: `Resource ${uri} returned no contents.` };
      const parts = contents.map((entry) => {
        if (typeof entry.text === "string") return entry.text;
        if (entry.blob) {
          return `[binary ${entry.mimeType ?? "application/octet-stream"}, ${entry.blob.length} base64 chars]`;
        }
        return JSON.stringify(entry);
      });
      return { output: parts.join("\n") };
    } catch (err: unknown) {
      return { output: `Failed to read MCP resource ${uri}: ${errorMessage(err)}`, is_error: true };
    }
  },
};
