/**
 * How full the context is, from the provider's own count when there is one.
 *
 * Every response reports the prompt it was given (input plus cache reads and
 * writes). That count, plus the reply and an estimate for whatever was
 * appended since, is the size of the next request. chars/4 is only the
 * fallback: code and JSON tokenize denser than that, so the estimate alone
 * let sessions run into the window before compacting.
 *
 * A history edit (compaction, clearing old tool output) invalidates the
 * reported count; the estimate covers the next request, and the response
 * after it reports again.
 */
import type { LlmMessage, TokenUsage } from "../providers/types.js";
import type { SessionLog } from "../session/log.js";
import { estimateMessageTokens, estimateTokens } from "./token-counter.js";

export interface ReportedContext {
  /** Prompt tokens the provider reported, plus the reply's output tokens. */
  tokens: number;
  /** Messages in the history once the reply was logged. */
  messageCount: number;
  /** Log length at that point; a log/replace after it invalidates the count. */
  logLength: number;
}

/** Record the size the provider reported, after its reply is in the log. */
export function reportedContext(usage: TokenUsage | undefined, log: SessionLog): ReportedContext | undefined {
  if (!usage) return undefined;
  const prompt = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  // A provider that reports nothing useful (0 prompt tokens) leaves the estimate in charge.
  if (prompt <= 0) return undefined;
  return { tokens: prompt + usage.output_tokens, messageCount: log.getMessages().length, logLength: log.length };
}

/** Tokens the next request will carry: reported plus estimated growth, or the estimate alone. */
export function contextTokens(
  systemPrompt: string,
  messages: LlmMessage[],
  log: SessionLog,
  reported: ReportedContext | undefined,
): number {
  if (reported && messages.length >= reported.messageCount && log.length >= reported.logLength && !replacedSince(log, reported.logLength)) {
    return reported.tokens + estimateMessageTokens(messages.slice(reported.messageCount));
  }
  return estimateTokens(systemPrompt) + estimateMessageTokens(messages);
}

function replacedSince(log: SessionLog, from: number): boolean {
  const events = log.all;
  for (let i = from; i < events.length; i++) {
    if (events[i].type === "log/replace") return true;
  }
  return false;
}
