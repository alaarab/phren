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
}

export interface AgentResult {
  finalText: string;
  turns: number;
  toolCalls: number;
  totalCost?: string;
  messages: LlmMessage[];
}

export interface AgentSession {
  messages: LlmMessage[];
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
  /** Abort signal — when aborted, the turn stops immediately. */
  signal?: AbortSignal;
}

// Re-import LlmMessage for the AgentResult/AgentSession interfaces
import type { LlmMessage } from "../providers/types.js";

export function createSession(contextLimit?: number): AgentSession {
  return {
    messages: [],
    turns: 0,
    toolCalls: 0,
    captureState: createCaptureState(),
    antiPatterns: new AntiPatternTracker(),
    flushConfig: createFlushConfig(contextLimit ?? 200_000),
  };
}
