import type { LlmProvider } from "../providers/types.js";
import type { PhrenContext } from "../memory/context.js";
import type { CostTracker } from "../cost.js";
import { ToolRegistry } from "../tools/registry.js";
import { createCaptureState, type CaptureState } from "../memory/auto-capture.js";
import { AntiPatternTracker } from "../memory/anti-patterns.js";
import type { LintTestConfig } from "../tools/lint-test.js";
import type { HooksConfig } from "../user-hooks.js";

export interface AgentConfig {
  provider: LlmProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  /** Fresh, non-persisted context for this root session; children do not inherit it. */
  turnContext?: (sessionId: string) => Promise<string | undefined>;
  maxTurns: number;
  verbose: boolean;
  phrenCtx?: PhrenContext | null;
  costTracker?: CostTracker | null;
  plan?: boolean;
  lintTestConfig?: LintTestConfig;
  hooks?: TurnHooks;
  hookConfig?: HooksConfig | null;
  /** Session ID for /session commands */
  sessionId?: string | null;
  /** Durable event log for the session (in-memory when absent). */
  sessionLog?: SessionLog;
  /** LLM compaction overrides (thresholds, disable flag). */
  compaction?: Partial<import("../context/compactor.js").CompactionConfig>;
  /** "chat": quick chat with no tools and read-only memory (memory/chat.ts). */
  mode?: "agent" | "chat";
  /** Chat mode only: register the agent's tools and prompt in place, keeping the history. */
  promote?: () => Promise<string>;
  /** Rebuilds the system prompt after a model switch when it is not the agent's (a chat's). */
  rebuildSystemPrompt?: (provider: { name: string; model?: string }) => string;
  /** The streaming text block beside the session's event log, for Phren Hook (session/preview.ts). */
  livePreview?: (sessionId: string) => import("../session/preview.js").LivePreview | undefined;
}

export interface AgentResult {
  finalText: string;
  turns: number;
  toolCalls: number;
  totalCost?: string;
  messages: LlmMessage[];
  /** The session the run used — lets callers flush session-scoped state at exit. */
  session: AgentSession;
}

export interface AgentSession {
  /** Append-only event log — the source of truth for model-visible history. */
  log: SessionLog;
  /** The projected message array the model sees (derived from the log). */
  readonly messages: LlmMessage[];
  turns: number;
  toolCalls: number;
  captureState: CaptureState;
  antiPatterns: AntiPatternTracker;
  /** Repeat-call guard chain (reset on direct user input). */
  repeatChain: RepeatChainState;
  /** The context size the provider last reported (context/usage.ts). */
  reportedContext?: import("../context/usage.js").ReportedContext;
}

/** Why runTurn returned. */
export type TurnStopReason = "end_turn" | "max_turns" | "budget" | "aborted" | "plan_rejected" | "hook_blocked";

export interface TurnResult {
  text: string;
  turns: number;
  toolCalls: number;
  stopReason: TurnStopReason;
}

/** UI hooks for pluggable rendering. Defaults write to stdout/stderr. */
export interface TurnHooks {
  /** Streaming text token. Default: process.stdout.write(text) */
  onTextDelta?: (text: string) => void;
  /** Streaming reasoning/thinking token. Default: dim stderr in verbose mode, hidden otherwise. */
  onReasoningDelta?: (text: string) => void;
  /** A reasoning segment finished (full text). Default: no-op. */
  onReasoningDone?: (text: string) => void;
  /** Final newline after a streaming text block. Default: write "\n" if needed */
  onTextDone?: (text: string) => void;
  /** Non-streaming text block output. Default: process.stdout.write */
  onTextBlock?: (text: string) => void;
  /** Before tool execution. Default: spinner */
  onToolStart?: (name: string, input: Record<string, unknown>, count: number) => void;
  /** After tool execution. Default: verbose log */
  onToolEnd?: (name: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number) => void;
  /** Status messages (prune, budget, cost). Default: stderr */
  onStatus?: (msg: string) => void;
  /** Mid-turn steering input injection. Return null for none. */
  getSteeringInput?: () => string | null;
  /** Plan approval override. Return { approved: true } to skip the readline
   *  prompt (e.g. in a TUI where per-tool approval handles gating instead). */
  onPlanApproval?: () => Promise<{ approved: boolean; feedback?: string }>;
  /** A model call failed and is being retried: drop any partial text or reasoning shown for it. */
  onStreamRetry?: () => void;
  /** A complete assistant message was recorded (after streaming finished). */
  onAssistantMessage?: (content: ContentBlock[], stopReason: "end_turn" | "tool_use" | "max_tokens") => void;
  /** Tool results were recorded (one entry per tool_use, in model order). */
  onToolResults?: (results: ContentBlock[]) => void;
  /** Abort signal — when aborted, the turn stops immediately. */
  signal?: AbortSignal;
}

// Re-import LlmMessage for the AgentResult/AgentSession interfaces
import type { ContentBlock, LlmMessage } from "../providers/types.js";
import { SessionLog } from "../session/log.js";
import { createRepeatChain, type RepeatChainState } from "../guards/repeat-tool-reminder.js";
import { randomUUID } from "crypto";

/** The context limit argument is unused (compaction reads the provider's window); kept for callers. */
export function createSession(_contextLimit?: number, options?: { log?: SessionLog }): AgentSession {
  const log =
    options?.log ??
    new SessionLog({
      sessionId: `mem-${randomUUID()}`,
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
    });
  return {
    log,
    get messages() {
      return log.getMessages();
    },
    turns: 0,
    toolCalls: 0,
    captureState: createCaptureState(),
    antiPatterns: new AntiPatternTracker(),
    repeatChain: createRepeatChain(),
  };
}
