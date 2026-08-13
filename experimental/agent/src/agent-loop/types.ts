import type { LlmProvider } from "../providers/types.js";
import type { PhrenContext } from "../memory/context.js";
import type { CostTracker } from "../cost.js";
import { ToolRegistry } from "../tools/registry.js";
import { createCaptureState, type CaptureState } from "../memory/auto-capture.js";
import { AntiPatternTracker } from "../memory/anti-patterns.js";
import { createFlushConfig, type FlushConfig } from "../memory/context-flush.js";
import type { LintTestConfig } from "../tools/lint-test.js";

export interface AgentConfig {
  provider: LlmProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  maxTurns: number;
  verbose: boolean;
  phrenCtx?: PhrenContext | null;
  costTracker?: CostTracker | null;
  plan?: boolean;
  lintTestConfig?: LintTestConfig;
  hooks?: TurnHooks;
  /** Session ID for /session commands */
  sessionId?: string | null;
  /** Durable event log for the session (in-memory when absent). */
  sessionLog?: SessionLog;
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
  flushConfig: FlushConfig;
}

export interface TurnResult {
  text: string;
  turns: number;
  toolCalls: number;
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
  /** Status messages (prune, flush, budget, cost). Default: stderr */
  onStatus?: (msg: string) => void;
  /** Mid-turn steering input injection. Return null for none. */
  getSteeringInput?: () => string | null;
  /** Plan approval override. Return { approved: true } to skip the readline
   *  prompt (e.g. in a TUI where per-tool approval handles gating instead). */
  onPlanApproval?: () => Promise<{ approved: boolean; feedback?: string }>;
  /** Abort signal — when aborted, the turn stops immediately. */
  signal?: AbortSignal;
}

// Re-import LlmMessage for the AgentResult/AgentSession interfaces
import type { LlmMessage } from "../providers/types.js";
import { SessionLog } from "../session/log.js";
import { randomUUID } from "crypto";

export function createSession(contextLimit?: number, options?: { log?: SessionLog }): AgentSession {
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
    flushConfig: createFlushConfig(contextLimit ?? 200_000),
  };
}
