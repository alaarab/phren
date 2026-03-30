/**
 * IPC message types for parent <-> child agent communication.
 *
 * All messages flow over Node's built-in IPC channel (process.send / process.on("message")).
 * Each message has a `type` discriminant for exhaustive switching.
 */

import type { PermissionMode } from "../permissions/types.js";

// ── Parent → Child ──────────────────────────────────────────────────────────

/** Sent once when the child process starts. Contains everything needed to run. */
export interface SpawnPayload {
  type: "spawn";
  /** Unique agent ID assigned by the spawner. */
  agentId: string;
  /** The task/prompt to execute. */
  task: string;
  /** Working directory for the child agent. */
  cwd: string;
  /** Provider name (openrouter, anthropic, openai, openai-codex, ollama). */
  provider?: string;
  /** Model override. */
  model?: string;
  /** Phren project name for memory context. */
  project?: string;
  /** Permission mode for tool execution. */
  permissions: PermissionMode;
  /** Max tool-use turns. */
  maxTurns: number;
  /** Optional budget cap in USD. */
  budget: number | null;
  /** Whether to run in plan mode. */
  plan: boolean;
  /** Verbose logging. */
  verbose: boolean;
  /** Env vars to forward (API keys, etc). */
  env: Record<string, string>;
  /** Path to a git worktree used for isolation. */
  worktreePath?: string;
}

/** Parent can send a cancellation signal. */
export interface CancelMessage {
  type: "cancel";
  agentId: string;
  reason?: string;
}

/** Parent delivers a direct message from another agent or the user. */
export interface DeliverMessage {
  type: "deliver_message";
  from: string;
  content: string;
}

/** Parent requests graceful shutdown — child should clean up and confirm. */
export interface ShutdownRequest {
  type: "shutdown_request";
  reason?: string;
}

/** Parent sends a follow-up task or message to wake an idle child. */
export interface WakeMessage {
  type: "wake";
  /** New task to execute, or empty to just resume with the message. */
  task?: string;
  /** Message content from another agent or the user. */
  message?: string;
  from?: string;
}

export type ParentMessage = SpawnPayload | CancelMessage | DeliverMessage | ShutdownRequest | WakeMessage;

// ── Child → Parent ──────────────────────────────────────────────────────────

/** Streaming text delta from the LLM. */
export interface TextDeltaEvent {
  type: "text_delta";
  agentId: string;
  text: string;
}

/** A complete text block (non-streaming fallback). */
export interface TextBlockEvent {
  type: "text_block";
  agentId: string;
  text: string;
}

/** Tool execution starting. */
export interface ToolStartEvent {
  type: "tool_start";
  agentId: string;
  toolName: string;
  input: Record<string, unknown>;
  count: number;
}

/** Tool execution finished. */
export interface ToolEndEvent {
  type: "tool_end";
  agentId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  durationMs: number;
}

/** Status message (context prune, flush, budget, cost). */
export interface StatusEvent {
  type: "status";
  agentId: string;
  message: string;
}

/** Agent completed its task successfully. */
export interface DoneEvent {
  type: "done";
  agentId: string;
  result: {
    finalText: string;
    turns: number;
    toolCalls: number;
    totalCost?: string;
  };
}

/** Agent encountered a fatal error. */
export interface ErrorEvent {
  type: "error";
  agentId: string;
  error: string;
}

/** Child sends a direct message to another agent. Parent routes it. */
export interface DirectMessageEvent {
  type: "direct_message";
  from: string;
  to: string;
  content: string;
}

/** Child confirms it has shut down cleanly. */
export interface ShutdownApproved {
  type: "shutdown_approved";
  agentId: string;
}

/** Child entered idle state (finished task, waiting for next instruction). */
export interface IdleNotification {
  type: "idle";
  agentId: string;
  idleReason: "task_complete" | "awaiting_input" | "available";
  /** Summaries of DMs received while the agent was running. */
  dmSummaries?: Array<{ from: string; content: string; timestamp: string }>;
}

export type ChildMessage =
  | TextDeltaEvent
  | TextBlockEvent
  | ToolStartEvent
  | ToolEndEvent
  | StatusEvent
  | DoneEvent
  | ErrorEvent
  | DirectMessageEvent
  | ShutdownApproved
  | IdleNotification;

// ── Combined ────────────────────────────────────────────────────────────────

export type IpcMessage = ParentMessage | ChildMessage;

// ── Agent registry types ────────────────────────────────────────────────────

export type AgentStatus = "starting" | "running" | "idle" | "done" | "error" | "cancelled";

export interface AgentEntry {
  id: string;
  task: string;
  status: AgentStatus;
  pid?: number;
  startedAt: number;
  finishedAt?: number;
  result?: DoneEvent["result"];
  error?: string;
  worktree?: { path: string; branch: string; agentId: string };
}
