// These tools work with the MCP client connection stored in the agent
// For now, create stub tools that explain MCP resources aren't connected yet
// The actual implementation depends on how mcp-client.ts stores connections
export const listMcpResourcesTool = {
    name: "list_mcp_resources",
    description: "List available resources from connected MCP servers. Resources are data endpoints that servers expose (database tables, config files, etc.).",
    input_schema: {
        type: "object",
        properties: {
            server: { type: "string", description: "Optional: filter by server name." },
        },
    },
    async execute(input) {
        // TODO: Wire to actual MCP client connections
        return { output: "No MCP resource connections available. Connect MCP servers with --mcp-config to use resources." };
    },
};
export const readMcpResourceTool = {
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
        return { output: "No MCP resource connections available. Connect MCP servers with --mcp-config to use resources." };
    },
};
