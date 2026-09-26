import type { LlmMessage } from "../providers/types.js";
import { toolResultText } from "../providers/types.js";

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate image tokens from base64 length. Anthropic prices roughly
 * width*height/750; for typical screenshots the byte count tracks pixel
 * count closely enough that bytes/750 (base64Len * 3/4 / 750) is a usable
 * heuristic — the point is that an image never counts as ~40 tokens of
 * block metadata the way an uncounted block would.
 */
export function estimateImageTokens(base64Data: string): number {
  return Math.max(64, Math.ceil((base64Data.length * 3) / 4 / 750));
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
          total += estimateTokens(toolResultText(block));
          if (Array.isArray(block.content)) {
            for (const part of block.content) {
              if (part.type === "image") total += estimateImageTokens(part.source.data);
            }
          }
        } else if (block.type === "tool_use") {
          total += estimateTokens(JSON.stringify(block.input));
        } else if (block.type === "reasoning") {
          // Reasoning text plus the round-trip payload (encrypted_content can
          // dominate on Codex; it is re-sent on every request).
          total += estimateTokens(block.text);
          if (block.encrypted_content) total += estimateTokens(block.encrypted_content);
        } else if (block.type === "image") {
          total += estimateImageTokens(block.source.data);
        } else {
          // Never let an unknown block count as 0 tokens: pruning decisions
          // would silently under-count and overrun the real context window.
          total += estimateTokens(JSON.stringify(block));
        }
      }
    }
  }
  return total;
}
