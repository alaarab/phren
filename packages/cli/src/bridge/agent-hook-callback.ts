import { request } from "node:http";
import { defaultPhrenPath } from "../shared.js";
import { activateModules as moduleSnapshot } from "../modules/runtime.js";
import { object, provider, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { hookOutput, STOP_TASKS_SENT, TOOL_HOOK_BUDGET_MS } from "./hook-fast.js";
import { underCodexDaemon } from "./codex-daemon.js";
import { codexAutoReview } from "./codex-review-mode.js";
import { claudeHeadlessThread, codexForeignThread } from "./thread-origin.js";
import { terminalPaneFromEnv } from "./terminal.js";
import { briefId, DISPATCH_ID_ENV } from "./launch-brief.js";
import { CODEX_SERVER_ENV, codexServerId } from "./codex-servers.js";
import { localSocket } from "./agent-hook-stores.js";

/** The agent side of the Hook's callbacks: `hook <source>` reads the agent's
 * payload and posts it to the daemon's local socket (agent-hooks.ts). */

/** A background task id as Claude Code writes them (an agent id, a shell id). */
export const BACKGROUND_TASK_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** What a Stop payload says about the turn it ends: the harness's last
 * assistant message (Claude, Codex) and, from Claude Code, the background
 * tasks still in flight, which will wake the conversation again when they
 * finish. Absent fields are left out, so the Hook falls back to the transcript. */
export function stopFacts(value: Json): { background?: number; backgroundTasks?: { id: string; running: boolean }[]; reply?: string } {
  const tasks = Array.isArray(value.background_tasks)
    ? value.background_tasks.filter(task => !["completed", "failed", "killed", "stopped"].includes(String(object(task).status))) : undefined;
  // Each task by id, running or not: a sub-agent's task id is its agent id, which the Hook's child tree keys on.
  // Running ones first, so a cut list loses finished tasks before running ones.
  const listed = Array.isArray(value.background_tasks) ? value.background_tasks.map(object)
    .filter(task => typeof task.id === "string" && BACKGROUND_TASK_ID.test(task.id))
    .map(task => ({ id: String(task.id), running: !["completed", "failed", "killed", "stopped"].includes(String(task.status)) }))
    .sort((a, b) => Number(b.running) - Number(a.running)).slice(0, STOP_TASKS_SENT) : undefined;
  return { ...(tasks ? { background: tasks.length } : {}), ...(listed ? { backgroundTasks: listed } : {}),
    ...(typeof value.last_assistant_message === "string" && value.last_assistant_message.trim() ? { reply: value.last_assistant_message.slice(0, 16_384) } : {}) };
}

/** One agent callback, run as `hook <source>`. Resolves "abandoned" when a
 * tool call's callback ran out of its budget: the caller then exits at once,
 * since a socket or a process read still pending would hold the agent. */
export async function agentHook(source: Provider, elapsed: () => number = () => performance.now()): Promise<void | "abandoned"> {
  provider.parse(source);
  // A missing helper must never prevent the coding agent from running.
  // Inside Herdr only Herdr's pane counts; elsewhere a tmux pane does.
  const place = await terminalPaneFromEnv();
  if (!place) return;
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 1_048_576) return; }
  const value = object(JSON.parse(input));
  if (value.agent_id || value.agentId || value.isSidechain || value.is_sidechain) return;
  // A `codex exec` or a subagent inside a Codex pane is not the pane's conversation.
  if (source === "codex" && await codexForeignThread(value.transcript_path).catch(() => false)) return;
  // So is a headless `claude -p` run inside a Claude pane.
  if (source === "claude" && await claudeHeadlessThread(value.transcript_path).catch(() => false)) return;
  const target = targetSchema.parse({ server: place.server, workspace: place.workspace, tab: place.tab,
    pane: place.pane, source, session: value.session_id || value.sessionId });
  const event = String(value.hook_event_name || "SessionStart");
  return withinToolBudget(event, left => forwardHook(source, target, event, value, left), elapsed);
}

/**
 * Runs a callback's work. A PreToolUse or PostToolUse callback gets what is
 * left of TOOL_HOOK_BUDGET_MS since its process started (hook-fast.ts says
 * why): "abandoned" once that runs out, and the caller exits without an
 * answer so the tool runs. Every other event runs to its own timeouts.
 */
export async function withinToolBudget<T>(event: string, work: (left: () => number) => Promise<T>,
  elapsed: () => number = () => performance.now(), budgetMs = TOOL_HOOK_BUDGET_MS): Promise<T | "abandoned"> {
  if (!event.endsWith("ToolUse")) return work(() => Infinity);
  const left = () => Math.floor(budgetMs - elapsed());
  if (left() <= 0) return "abandoned";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"abandoned">(resolve => { timer = setTimeout(() => resolve("abandoned"), left()); });
  try { return await Promise.race([work(left), expired]); } finally { clearTimeout(timer); }
}

async function forwardHook(source: Provider, target: Target, event: string, value: Json, left: () => number): Promise<void> {
  const modules = moduleSnapshot(defaultPhrenPath(), undefined, true);
  if (!modules.has("hook")) return;
  // Codex 0.157 runs hooks inside its shared app-server daemon, whose pane
  // variables belong to whichever pane first started it.
  // The Hook's own per-pane app-server (codex-servers.ts) runs its hooks
  // with that pane's variables, so they are trusted like a pane's own.
  const ownServer = source === "codex" && codexServerId.safeParse(process.env[CODEX_SERVER_ENV]).success;
  const daemon = source === "codex" && !ownServer && await underCodexDaemon().catch(() => false);
  // Codex asks this hook before its automatic reviewer: say when that
  // reviewer, not the owner, will decide.
  const autoReview = source === "codex" && event === "PermissionRequest" && await codexAutoReview(value.transcript_path);
  // A worker the Hook launched with its brief carries that dispatch's id. A
  // daemon's variables belong to another pane, so it sends none.
  const dispatchId = !daemon && (event === "SessionStart" || event === "UserPromptSubmit") && briefId.safeParse(process.env[DISPATCH_ID_ENV]).success
    ? process.env[DISPATCH_ID_ENV] : undefined;
  const data = JSON.stringify({ target, event, ...(daemon ? { daemon: true } : {}), ...(autoReview ? { autoReview: true } : {}), ...(dispatchId ? { dispatchId } : {}),
    ...(source === "claude" && typeof value.transcript_path === "string" ? { transcript: value.transcript_path.slice(0, 4096) } : {}),
    tool: value.tool_name, input: value.tool_input, toolUseId: value.tool_use_id, cwd: value.cwd,
    ...(event === "UserPromptSubmit" && typeof value.prompt === "string" ? { prompt: value.prompt.slice(0, 65_536) } : {}),
    ...(event === "SessionStart" && typeof value.source === "string" ? { startSource: value.source.slice(0, 32) } : {}),
    ...(event === "Stop" ? stopFacts(value) : {}) });
  await new Promise<void>(resolve => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST", timeout: event === "PermissionRequest" ? 58_000 : event.endsWith("ToolUse") ? Math.max(1, left()) : 12_000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => {
      let result = "";
      res.on("data", chunk => { result += chunk.toString(); if (result.length > 16_384) req.destroy(); });
      // Forward approval/refusal decisions and validated turn context.
      // Tool callbacks stay silent, and an empty reply says nothing.
      res.on("end", () => { if (res.statusCode === 200) process.stdout.write(hookOutput(event, result)); resolve(); });
      res.on("error", () => resolve());
    });
    req.on("error", () => resolve()); req.on("timeout", () => { req.destroy(); resolve(); }); req.end(data);
  });
}
