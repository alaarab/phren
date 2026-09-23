import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hookRequest } from "../bridge/client.js";
import { dispatchSchema } from "../bridge/dispatch.js";
import { handOff, handOffSchema, listLiveSessions } from "../bridge/hand-off.js";
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
  server.registerTool("live_sessions", {
    title: "◆ phren · live sessions",
    description: "List the live agent sessions on this computer and every enrolled computer: computer, project, harness, status, role and the target hand_off takes. Computers that could not be reached are listed separately.",
    inputSchema: {},
  }, async () => {
    try {
      const result = await listLiveSessions();
      const note = result.peerError ? ` Enrolled computers were skipped: ${result.peerError}`
        : result.enrolled === 0 ? " No other computers are enrolled here; run `phren bridge enroll-computer` to add them." : "";
      return mcpResponse({ ok: true, data: result, message: `${result.sessions.length} live sessions across ${result.enrolled + 1} computers.${note}` });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Could not list live sessions." });
    }
  });
  server.registerTool("hand_off", {
    title: "◆ phren · hand off",
    description: "Deliver a prompt to an existing local or enrolled-computer agent session through Phren Hook. Prefer a session that already owns the project and is idle or doing related work.",
    inputSchema: handOffSchema,
  }, async input => {
    try {
      const result = await handOff(input);
      return mcpResponse({ ok: result.ok, data: result, message: result.delivered ? "Prompt delivered to the existing session." : "Prompt delivery was not confirmed." });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Hand-off failed." });
    }
  });
}
