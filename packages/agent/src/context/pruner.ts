import type { LlmMessage, ContentBlock } from "../providers/types.js";
import { estimateTokens, estimateMessageTokens } from "./token-counter.js";

export interface PruneConfig {
  contextLimit: number;
  keepRecentTurns: number;
}

const DEFAULT_CONFIG: PruneConfig = {
  contextLimit: 200_000,
  keepRecentTurns: 6,
};

/** Returns true when the conversation is approaching context limits. */
export function shouldPrune(
  systemPrompt: string,
  messages: LlmMessage[],
  config?: Partial<PruneConfig>,
): boolean {
  const limit = config?.contextLimit ?? DEFAULT_CONFIG.contextLimit;
  const systemTokens = estimateTokens(systemPrompt);
  const msgTokens = estimateMessageTokens(messages);
  return (systemTokens + msgTokens) > limit * 0.75;
}

/** Prune messages, keeping the first (original task) and last N turn pairs. */
export function pruneMessages(
  messages: LlmMessage[],
  config?: Partial<PruneConfig>,
): LlmMessage[] {
  const keepRecent = config?.keepRecentTurns ?? DEFAULT_CONFIG.keepRecentTurns;
  const keepRecentMessages = keepRecent * 2; // each turn = user + assistant

  // Not enough messages to prune
  if (messages.length <= keepRecentMessages + 1) {
    return messages;
  }

  const first = messages[0]; // original task

  // Walk backwards from split point to ensure tail starts with a user text message,
  // not a tool_result-only message (which would be orphaned without its tool_use).
  let splitIdx = messages.length - keepRecentMessages;
  while (splitIdx > 1) {
    const msg = messages[splitIdx];
    if (msg.role === "user") {
      // Check if this is a text message (not just tool_results)
      if (typeof msg.content === "string") break;
      const hasText = msg.content.some((b: ContentBlock) => b.type === "text");
      if (hasText) break;
    }
    splitIdx--;
  }

  const middle = messages.slice(1, splitIdx);
  const tail = messages.slice(splitIdx);

  // Collect tool names used in the pruned middle section
  const toolsUsed = new Set<string>();
  for (const msg of middle) {
    if (typeof msg.content !== "string") {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolsUsed.add(block.name);
        }
      }
    }
  }

  const summaryText = [
    `[Context compacted: ${middle.length} messages removed]`,
    toolsUsed.size > 0 ? `Tools used: ${[...toolsUsed].join(", ")}` : null,
    `Key points: ${middle.length} intermediate turns were compacted to fit context window.`,
  ]
    .filter(Boolean)
    .join("\n");

  const summaryMessage: LlmMessage = {
    role: "user",
    content: summaryText,
  };

  return [first, summaryMessage, ...tail];
}
