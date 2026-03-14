/**
 * Convert an McpToolResult into the MCP SDK response format.
 * Single shared implementation — replaces the per-file jsonResponse() duplicates.
 */
export function mcpResponse(payload) {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
