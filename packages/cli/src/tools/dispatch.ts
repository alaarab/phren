import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hookRequest } from "../bridge/client.js";
import { dispatchSchema } from "../bridge/dispatch.js";
import { handOff, handOffSchema, listLiveSessions } from "../bridge/hand-off.js";
import { readAccountUsage, usageSummary } from "../bridge/account-usage.js";
import { terminalPaneFromEnv } from "../bridge/terminal.js";
import { mcpResponse } from "./types.js";

export function register(server: McpServer): void {
  server.registerTool("dispatch", {
    title: "◆ phren · dispatch",
    description: "Send a worker brief to an enrolled computer through the local Phren Hook. Returns a launch receipt and remote target. The worker's finish, question or exit comes back later through dispatch_returns. Never automatically retry an uncertain delivery.",
    inputSchema: dispatchSchema,
  }, async input => {
    try {
      // The pane this agent runs in receives the one-line return notices.
      const origin = await terminalPaneFromEnv();
      const result = await hookRequest("/v1/dispatch", { ...input, ...(origin ? { origin } : {}) }, undefined, 180_000);
      return mcpResponse({ ok: result.ok === true, data: result, message: `${result.computer}: ${result.state}.` });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Dispatch failed." });
    }
  });
  server.registerTool("dispatch_returns", {
    title: "◆ phren · dispatch returns",
    description: "List unread returns from dispatched workers and mark them read: the worker finished (done, with its final reply), finished by asking the owner something (needs-you, with the question), failed (the harness ended the turn on an error such as a usage limit, with the error), is blocked on terminal input, or its pane is gone. A blocked row with an `approval` field (actionId, tool, request) is a permission request the worker is waiting on, forwarded from its computer: answer it with dispatch_approve. A worker that ended its turn with background tasks pending is waited on for up to two hours; a row has `waited` (the most tasks it waited on) or, if some were still running after that, `background`. Each row has the dispatch id, computer, project, label and the worker's target for hand_off.",
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
  server.registerTool("dispatch_approve", {
    title: "◆ phren · dispatch approve",
    description: "Answer the permission request a dispatched worker is waiting on, forwarded from its computer: a dispatch_returns row with an approval field names it. The owner's standing grants already answer the dispatch and hand_off requests they cover. Only the agent that dispatched the worker can answer, never the worker itself. Pass the approval's actionId, so a request that changed since you read it is never answered blind. Deny when unsure and ask the owner.",
    inputSchema: {
      id: z.string().uuid().describe("Dispatch id from dispatch_returns."),
      decision: z.enum(["approve", "deny"]),
      actionId: z.string().min(1).max(200).describe("The approval's actionId from dispatch_returns; a request that has since changed is refused."),
    },
  }, async input => {
    try {
      const origin = await terminalPaneFromEnv();
      const result = await hookRequest("/v1/dispatch/approve", { ...input, ...(origin ? { origin } : {}) });
      return mcpResponse({ ok: result.ok === true, data: result, message: input.decision === "approve" ? "Approved." : "Denied." });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Could not answer the approval." });
    }
  });
  server.registerTool("live_sessions", {
    title: "◆ phren · live sessions",
    description: "List the live agent sessions on this computer and every enrolled computer: computer, project, harness, status (working, with backgroundTasks, while background work runs after the main turn ended), idleFor (seconds since the tab last changed), role and the target hand_off takes. Computers that could not be reached are listed separately, and computers registered in the store but not linked in hooks.yaml come back in notLinked: their sessions are unknown, not absent.",
    inputSchema: {},
  }, async () => {
    try {
      const result = await listLiveSessions();
      const note = result.peerError ? ` Enrolled computers were skipped: ${result.peerError}`
        : result.enrolled === 0 && !result.notLinked.length ? " No other computers are linked here; `phren bridge discover` lists the ones you already reach over ssh, and `phren bridge link <host>` links one." : "";
      const unlinked = result.notLinked.length
        ? ` Not linked, so not checked (this does not mean nothing is running there): ${result.notLinked.map(item => item.aliases?.length ? `${item.name} (also ${item.aliases.join(", ")})` : item.name).join("; ")}. If you reach one over ssh, the owner can link it with \`phren bridge link <host>\`; never link a computer without the owner asking.` : "";
      return mcpResponse({ ok: true, data: result, message: `${result.sessions.length} live sessions across ${result.enrolled + 1} computers.${note}${unlinked}` });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Could not list live sessions." });
    }
  });
  server.registerTool("account_usage", {
    title: "◆ phren · account usage",
    description: "Agent usage on this computer and every enrolled computer, merged by account: one row per Claude login, Codex, OpenCode, OpenCode Go, OpenRouter and GitHub Copilot, with its windows (percent used, percent left, reset time), leftPercent (the least room on any window), nearLimit (under 20% left or refusing requests), freshness (updatedAt, age, stale), and the computers where it is signed in with the Claude account id dispatch takes there. A window whose reset passed says reset and has no percent; a report over 15 minutes old is stale. Call it before dispatch to pick a harness, account and computer with room. Harnesses no computer reported are in noData; unreachable computers and computers not linked in hooks.yaml are listed separately: their usage is unknown, not zero.",
    inputSchema: {},
  }, async () => {
    try {
      const result = await readAccountUsage();
      const note = result.peerError ? ` Enrolled computers were skipped: ${result.peerError}` : "";
      return mcpResponse({ ok: true, data: result, message: `${usageSummary(result)}${note}` });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Could not read account usage." });
    }
  });
  server.registerTool("authority", {
    title: "◆ phren · release authority",
    description: "Read the owner's release authority policy: per project, which release-type actions (merge, publish, deploy, app-store, github-admin) are go and which are ask-first, and the highest permission mode an agent may start a worker in there. Quote the project's `line` in a brief that asks for release work, and declare those actions in dispatch's releaseActions. An ask-first action needs the owner's confirmation first; ask the owner, never try to confirm it yourself. Read-only: only the owner changes the policy. Without project, lists every project the policy names.",
    inputSchema: { project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/).optional().describe("Project slug; omit to list the whole policy.") },
  }, async input => {
    try {
      const result = await hookRequest(`/v1/authority${input.project ? `?project=${encodeURIComponent(input.project)}` : ""}`);
      const one = result.authority as { line?: string } | undefined;
      return mcpResponse({ ok: true, data: result, message: one?.line ?? `${Array.isArray(result.projects) ? result.projects.length : 0} projects in the release authority policy.` });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Could not read the release authority policy." });
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
