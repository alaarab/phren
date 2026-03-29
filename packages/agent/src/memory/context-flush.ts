/**
 * Context flush: one-time knowledge extraction when context is getting large.
 * Triggers once at 75% context usage, injecting a summary-extraction prompt.
 */
import type { LlmMessage } from "../providers/types.js";
import { estimateTokens, estimateMessageTokens } from "../context/token-counter.js";

export interface FlushConfig {
  contextLimit: number;
  triggered: boolean;
}

export function createFlushConfig(contextLimit: number): FlushConfig {
  return { contextLimit, triggered: false };
}

const FLUSH_PROMPT =
  "Before continuing, briefly summarize the key decisions, patterns, and discoveries from this conversation so far. " +
  "Focus on non-obvious findings that would be valuable to remember in future sessions. " +
  "Be concise — 3-5 bullet points maximum.";

/**
 * Check if a context flush should be injected.
 * Returns the flush message to inject, or null if not needed.
 * Only triggers once per session.
 */
export function checkFlushNeeded(
  systemPrompt: string,
  messages: LlmMessage[],
  config: FlushConfig,
): string | null {
  if (config.triggered) return null;

  const systemTokens = estimateTokens(systemPrompt);
  const msgTokens = estimateMessageTokens(messages);
  const usage = (systemTokens + msgTokens) / config.contextLimit;

  if (usage >= 0.75) {
    config.triggered = true;
    return FLUSH_PROMPT;
  }

  return null;
}
