/**
 * Clear old tool output before compacting.
 *
 * In a long tool loop most of the context is output the model has already
 * used: file reads, test logs, search results. Replacing the bulky ones
 * outside the most recent few with a one-line note frees that space without
 * a summarization call and without losing the conversation itself, the way
 * Claude Code and OpenCode prune old tool results. The full output stays in
 * the session log (the caller applies each change as a log/replace).
 */
import type { ContentBlock, LlmMessage, ToolResultBlock } from "../providers/types.js";
import { toolResultText } from "../providers/types.js";

export interface ClearConfig {
  /** The newest tool results kept whole. */
  keepRecent: number;
  /** Outputs shorter than this (chars) are kept; clearing them saves little. */
  minChars: number;
}

export const DEFAULT_CLEAR: ClearConfig = { keepRecent: 8, minChars: 2_000 };

const CLEARED_PREFIX = "[Earlier output cleared to save context";

/** A message to swap in at `index`. */
export interface ClearedMessage {
  index: number;
  message: LlmMessage;
}

/** Plan which old tool results to clear. Returns [] when there is nothing worth clearing. */
export function planToolResultClearing(messages: LlmMessage[], config: Partial<ClearConfig> = {}): ClearedMessage[] {
  const { keepRecent, minChars } = { ...DEFAULT_CLEAR, ...config };
  const names = new Map<string, string>();
  const results: Array<{ index: number; block: ToolResultBlock }> = [];
  messages.forEach((msg, index) => {
    if (typeof msg.content === "string") return;
    for (const block of msg.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
      else if (block.type === "tool_result") results.push({ index, block });
    }
  });

  const clear = new Map<number, Set<ToolResultBlock>>();
  for (const { index, block } of results.slice(0, Math.max(0, results.length - keepRecent))) {
    const text = toolResultText(block);
    const hasImage = Array.isArray(block.content) && block.content.some((part) => part.type === "image");
    if (text.startsWith(CLEARED_PREFIX) || (text.length < minChars && !hasImage)) continue;
    if (!clear.has(index)) clear.set(index, new Set());
    clear.get(index)!.add(block);
  }

  return [...clear].map(([index, blocks]) => {
    const content = (messages[index].content as ContentBlock[]).map((block): ContentBlock => {
      if (block.type !== "tool_result" || !blocks.has(block)) return block;
      const text = toolResultText(block);
      const tool = names.get(block.tool_use_id) ?? "the tool";
      const firstLine = text.split("\n", 1)[0].slice(0, 120);
      return {
        ...block,
        content: `${CLEARED_PREFIX}: ${tool} returned ${text.length} chars, starting "${firstLine}". Run it again if you need it.]`,
      };
    });
    return { index, message: { ...messages[index], content } };
  });
}
