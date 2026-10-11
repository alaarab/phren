import { prsSchema } from "../bridge/return-contract.js";
import { ownerInboxSchema } from "../bridge/owner-inbox.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hookRequest } from "../bridge/client.js";
import { dispatchSchema } from "../bridge/dispatch.js";
import { handOff, handOffSchema, listLiveSessions, moveSession, moveSessionSchema } from "../bridge/hand-off.js";
import { readAccountUsage, usageSummary } from "../bridge/account-usage.js";
import { terminalPaneFromEnv } from "../bridge/terminal.js";
import { dispatchIdFromEnv } from "../bridge/launch-brief.js";
import { approvalDecisions } from "../bridge/protocol.js";
import { mcpResponse } from "./types.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

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
  server.registerTool("dispatch_report", {
    title: "◆ phren · report PRs",
    description: "Report PR evidence to this worker's own Hook before finishing the turn. The done return carries prs (url, repo, branch, tests summary, notes), and the Hook queues it to the configured integrator. No direct worker messaging or GitHub comment is needed. Does not claim tests passed or complete a task.",
    inputSchema: { prs: prsSchema },
  }, async input => {
    try {
      const origin = await terminalPaneFromEnv();
      if (!origin) throw new Error("Run dispatch_report inside the worker's terminal pane.");
      // The launch's dispatch id lets the Hook accept a report whose turn it did not record (worker-reports.ts).
      const dispatch = dispatchIdFromEnv();
      const result = await hookRequest("/v1/dispatch/report", { ...input, origin, ...(dispatch ? { dispatch } : {}) });
      return mcpResponse({ ok: result.ok === true, data: result, message: "PR evidence recorded for this turn's done return." });
    } catch (error) { return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Could not report PR evidence." }); }
  });
  server.registerTool("owner_inbox", {
    title: "◆ phren · owner inbox",
    description: "One owner inbox on this conductor's Hook: list open needs-you returns, blocked prompts and manual items; add a title and optional project; resolve an id with an optional resolution. Automatic items are deduplicated by pane, session and question, and resolve when their source stops waiting or disappears; only verified live automatic items are listed. Manual items remain until resolved. Reading returns does not resolve inbox items. Resolving an inbox item does not answer or approve a worker prompt. Use operation add, list or resolve (also through phren_admin action owner_inbox). includeResolved lists history. Keep an id on retried adds.",
    inputSchema: ownerInboxSchema.omit({ action: true }).extend({ operation: ownerInboxSchema.shape.action }),
  }, async input => {
    try {
      const { operation, ...rest } = input;
      const result = await hookRequest("/v1/owner-inbox", { ...rest, action: operation ?? "list" });
      return mcpResponse({ ok: result.ok === true, data: result, message: input.operation === "add" ? "Added to the owner inbox." : input.operation === "resolve" ? "Owner inbox item resolved." : `${Array.isArray(result.items) ? result.items.length : 0} owner inbox items.` });
    } catch (error) { return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Could not read the owner inbox." }); }
  });
  server.registerTool("dispatch_returns", {
    title: "◆ phren · dispatch returns",
    description: "List unread returns from dispatched workers and mark them read: the worker finished (done, with its final reply), finished by asking the owner something (needs-you, with the question), failed (the harness ended the turn on an error such as a usage limit, with the error), is blocked on terminal input, or its pane is gone. A blocked row with an `approval` field (actionId, tool, request) is a permission request the worker is waiting on, forwarded from its computer: answer it with dispatch_approve. A worker that ended its turn with background tasks pending is waited on for up to two hours; a row has `waited` (the most tasks it waited on) or, if some were still running after that, `background`. A stalled row flags an unchanged working screen and transcript. A done row can include structured prs and integratorDelivery. Reading a done return closes its finished pane unless closeOnFinish:false was specified, after rechecking new and queued work. Each row has the dispatch id, computer, project, label and the worker's target for hand_off. When the owner has turned on `phren config account-failover on` (off by default), a Claude worker that stopped at its usage limit is continued on another signed-in account with room (same computer first, never the same login before its window resets): its row comes back with continued (the new dispatch id, computer and account, or why none could) and the error says \"Continued on account X\".",
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
      decision: z.enum(approvalDecisions),
      actionId: z.string().min(1).max(200).describe("The approval's actionId from dispatch_returns; a request that has since changed is refused."),
    },
  }, async input => {
    try {
      const origin = await terminalPaneFromEnv();
      const result = await hookRequest("/v1/dispatch/approve", { ...input, ...(origin ? { origin } : {}) });
      return mcpResponse({ ok: result.ok === true, data: result, message: input.decision === "deny" ? "Denied." : "Approved." });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Could not answer the approval." });
    }
  });
  server.registerTool("live_sessions", {
    title: "◆ phren · live sessions",
    description: "List the live agent sessions on this computer and every enrolled computer: computer, project, harness, status (working, with backgroundTasks, while background work runs after the main turn ended), idleFor (seconds since the tab last changed), role, the target hand_off takes, and for Claude sessions quota (the account's 5-hour and weekly percent left and reset time). claudeAccounts lists every signed-in Claude account per computer with the same room. Computers that could not be reached are listed separately, and computers registered in the store but not linked in hooks.yaml come back in notLinked: their sessions are unknown, not absent.",
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
    description: "Agent usage on this computer and every enrolled computer, merged by account: one row per Claude login, Codex, OpenCode, OpenCode Go, OpenRouter and GitHub Copilot, with its windows (percent used, percent left, reset time), leftPercent (the least room on any window), nearLimit (under 20% left: information, not a reason to avoid it), exhausted (a window at 100% or refusing requests, with availableIn), freshness (updatedAt, age, stale), and the computers where it is signed in with the Claude account id dispatch takes there. A window whose reset passed says reset and has no percent; a report over 15 minutes old is stale. Call it before dispatch: never send work to an exhausted account; a low one is fine, and one that resets soon is worth using before it does. Harnesses no computer reported are in noData; unreachable computers and computers not linked in hooks.yaml are listed separately: their usage is unknown, not zero.",
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
  server.registerTool("move_session", {
    title: "◆ phren · move session",
    description: "Move a live session to another agent on its own computer: the agent writes a structured hand-off (goal, done, current state, decisions, next steps, open questions, key files), exits with its own exit command, and the target harness (claude with an optional account, codex, opencode or copilot, with an optional model and effort) starts in the same pane and folder with that hand-off as its first prompt. If the agent writes no hand-off in time, Phren builds one from the end of its transcript, the git state and the original brief. Nothing is committed; the hand-off lists the uncommitted changes. Only harnesses signed in and usable on that computer are accepted. A dispatched worker keeps its dispatch: its receipt follows the new agent and records the move under moves. Waits up to five minutes; pass id with status:true to check a move later.",
    inputSchema: moveSessionSchema,
  }, async input => {
    try {
      const result = await moveSession(input);
      const move = result.move;
      const message = move.state === "moved" ? `Moved to ${String(object(move.to).harness)} (${String(move.placement)}); hand-off at ${String(object(move.handoff).path)}.`
        : move.state === "failed" ? `Move failed: ${String(move.error ?? "unknown error")}` : `Move ${String(move.id)} is ${String(move.state)}; check again with status:true.`;
      return mcpResponse({ ok: result.ok, data: result, message });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Could not move the session." });
    }
  });
  server.registerTool("hand_off", {
    title: "◆ phren · hand off",
    description: "Deliver a prompt to an existing local or enrolled-computer agent session through Phren Hook. Busy workers receive a durable queued message at their next idle. Keep deliveryId on retries. Use status:true with deliveryId and target or session to read queued, delivered, uncertain or failed without sending. Uncertain delivery is never retried automatically.",
    inputSchema: handOffSchema,
  }, async input => {
    try {
      const result = await handOff(input);
      return mcpResponse({ ok: result.ok, data: result, message: result.delivered ? "Prompt delivered to the existing session." : result.queued ? `Prompt queued as ${result.deliveryId}. The Hook will deliver it at idle and notify the sender.` : "Prompt delivery was not confirmed; do not resend with a new id." });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "Hand-off failed." });
    }
  });
}
