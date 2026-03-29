import type { LlmMessage, ContentBlock } from "../providers/types.js";

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate total tokens across a message array. */
export function estimateMessageTokens(messages: LlmMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += 4; // per-message overhead
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else {
      for (const block of msg.content) {
        if (block.type === "text") {
          total += estimateTokens(block.text);
        } else if (block.type === "tool_result") {
          total += estimateTokens(block.content);
        } else if (block.type === "tool_use") {
          total += estimateTokens(JSON.stringify(block.input));
        }
      }
    }
  }
  return total;
}
