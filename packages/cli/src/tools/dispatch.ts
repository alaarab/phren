import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hookRequest } from "../bridge/client.js";
import { dispatchSchema } from "../bridge/dispatch.js";
import { handOff, handOffSchema, listLiveSessions } from "../bridge/hand-off.js";
import { herdrPaneFromEnv } from "../bridge/herdr.js";
import { mcpResponse } from "./types.js";

export function register(server: McpServer): void {
  server.registerTool("dispatch", {
    title: "◆ phren · dispatch",
    description: "Send a worker brief to an enrolled computer through the local Phren Hook. Returns a launch receipt and remote target. The worker's finish, question or exit comes back later through dispatch_returns. Never automatically retry an uncertain delivery.",
    inputSchema: dispatchSchema,
  }, async input => {
    try {
      // The pane this agent runs in receives the one-line return notices.
      const origin = herdrPaneFromEnv();
      const result = await hookRequest("/v1/dispatch", { ...input, ...(origin ? { origin } : {}) }, undefined, 180_000);
      return mcpResponse({ ok: result.ok === true, data: result, message: `${result.computer}: ${result.state}.` });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Dispatch failed." });
    }
  });
  server.registerTool("dispatch_returns", {
    title: "◆ phren · dispatch returns",
    description: "List unread returns from dispatched workers and mark them read: the worker finished (done, with its final reply), finished by asking the owner something (needs-you, with the question), is blocked on terminal input, or its pane is gone. Each row has the dispatch id, computer, project, label and the worker's target for hand_off.",
    inputSchema: {},
  }, async () => {
    try {
      const result = await hookRequest("/v1/dispatch/returns", {});
      const returns = Array.isArray(result.returns) ? result.returns : [];
      return mcpResponse({ ok: true, data: result, message: returns.length ? `${returns.length} unread returns.` : "No unread returns." });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Could not read dispatch returns." });
    }
  });
  server.registerTool("live_sessions", {
    title: "◆ phren · live sessions",
    description: "List the live agent sessions on this computer and every enrolled computer: computer, project, harness, status, idleFor (seconds since the tab last changed), role and the target hand_off takes. Computers that could not be reached are listed separately, and computers registered in the store but not linked in hooks.yaml come back in notLinked: their sessions are unknown, not absent.",
    inputSchema: {},
  }, async () => {
    try {
      const result = await listLiveSessions();
      const note = result.peerError ? ` Enrolled computers were skipped: ${result.peerError}`
        : result.enrolled === 0 && !result.notLinked.length ? " No other computers are enrolled here; run `phren bridge enroll-computer` to add them." : "";
      const unlinked = result.notLinked.length
        ? ` Not linked, so not checked (this does not mean nothing is running there): ${result.notLinked.map(item => item.aliases?.length ? `${item.name} (also ${item.aliases.join(", ")})` : item.name).join("; ")}. Link one with \`phren bridge enroll-computer\`.` : "";
      return mcpResponse({ ok: true, data: result, message: `${result.sessions.length} live sessions across ${result.enrolled + 1} computers.${note}${unlinked}` });
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
