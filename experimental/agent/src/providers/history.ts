import type { ContentBlock, LlmMessage, ReasoningBlock } from "./types.js";

/**
 * Drop reasoning blocks that did not originate from `providerName`.
 *
 * A reasoning block carries provider-private round-trip material (Anthropic
 * signatures, Codex encrypted_content). Sending it to a different provider —
 * or to the same provider under a different account/model in some cases —
 * fails the request, and because history is durable that failure would repeat
 * on every subsequent turn. Text-only reasoning from another provider is
 * dropped too: it was that model's private scratchpad, not conversation.
 *
 * Untagged reasoning blocks (no `provider` field) are also dropped — they
 * predate tagging (e.g. Anthropic thinking blocks that leaked through the
 * batch path's unchecked cast) and cannot be trusted to round-trip.
 */
export function stripForeignReasoning(
  messages: LlmMessage[],
  providerName: string | undefined,
): LlmMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    if (!m.content.some((b) => isForeignReasoning(b, providerName))) return m;
    return { ...m, content: m.content.filter((b) => !isForeignReasoning(b, providerName)) };
  });
}

/** With no provider name, every reasoning block is foreign (strip all). */
function isForeignReasoning(block: ContentBlock, providerName: string | undefined): boolean {
  return block.type === "reasoning" && (providerName === undefined || block.provider !== providerName);
}

/** Reasoning blocks of a message, in order (empty for string content). */
export function reasoningBlocks(message: LlmMessage): ReasoningBlock[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((b): b is ReasoningBlock => b.type === "reasoning");
}
