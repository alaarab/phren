import type { LlmMessage, ContentBlock, ToolUseBlock, ToolResultBlock } from "../providers/types.js";
import { toolResultText } from "../providers/types.js";
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

// ── Fact extraction (regex only, no LLM) ────────────────────────────────────

const FILE_TOOL_NAMES = new Set(["edit_file", "write_file"]);
const SEARCH_TOOL_NAMES = new Set(["phren_search"]);

const DECISION_RE = /\b(?:I'll|Let's|The fix is|Changed|because|decided to|switched to|replaced|removed|added|created|updated|refactored)\b/i;

interface ExtractedFacts {
  filesModified: string[];
  errors: string[];
  keyActions: string[];
  searches: string[];
}

/** Extract key facts from messages about to be pruned. Fast regex-only scan. */
export function extractFacts(messages: LlmMessage[]): ExtractedFacts {
  const filesSet = new Set<string>();
  const errorsSet = new Set<string>();
  const actionsSet = new Set<string>();
  const searchesSet = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      // Scan assistant text messages for key decisions
      if (msg.role === "assistant") {
        extractDecisions(msg.content, actionsSet);
      }
      continue;
    }

    for (const block of msg.content) {
      if (block.type === "tool_use") {
        extractFromToolUse(block, filesSet, searchesSet);
      } else if (block.type === "tool_result" && block.is_error) {
        extractError(block, errorsSet);
      } else if (block.type === "text" && msg.role === "assistant") {
        extractDecisions(block.text, actionsSet);
      }
    }
  }

  return {
    filesModified: [...filesSet],
    errors: [...errorsSet],
    keyActions: [...actionsSet],
    searches: [...searchesSet],
  };
}

function extractFromToolUse(
  block: ToolUseBlock,
  filesSet: Set<string>,
  searchesSet: Set<string>,
): void {
  if (FILE_TOOL_NAMES.has(block.name)) {
    const fp = block.input?.file_path;
    if (typeof fp === "string" && fp) {
      filesSet.add(fp);
    }
  }
  if (SEARCH_TOOL_NAMES.has(block.name)) {
    const q = block.input?.query;
    if (typeof q === "string" && q) {
      searchesSet.add(q);
    }
  }
}

function extractError(block: ToolResultBlock, errorsSet: Set<string>): void {
  const firstLine = toolResultText(block).split("\n")[0].trim();
  if (firstLine) {
    // Cap length to keep summary concise
    errorsSet.add(firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine);
  }
}

const MAX_KEY_ACTIONS = 5;

function extractDecisions(text: string, actionsSet: Set<string>): void {
  if (actionsSet.size >= MAX_KEY_ACTIONS) return;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && DECISION_RE.test(trimmed)) {
      const capped = trimmed.length > 100 ? trimmed.slice(0, 100) + "..." : trimmed;
      actionsSet.add(capped);
      if (actionsSet.size >= MAX_KEY_ACTIONS) return;
    }
  }
}

// ── Summary formatting ──────────────────────────────────────────────────────

function formatFactSummary(middle: LlmMessage[], toolsUsed: Set<string>): string {
  const facts = extractFacts(middle);

  const lines: string[] = [
    `[Context compacted: ${middle.length} messages removed]`,
  ];

  if (toolsUsed.size > 0) {
    lines.push(`Tools used: ${[...toolsUsed].join(", ")}`);
  }
  if (facts.filesModified.length > 0) {
    lines.push(`Files modified: ${facts.filesModified.join(", ")}`);
  }
  if (facts.errors.length > 0) {
    lines.push(`Errors encountered: ${facts.errors.join(", ")}`);
  }
  if (facts.keyActions.length > 0) {
    lines.push(`Key actions: ${facts.keyActions.join(", ")}`);
  }
  if (facts.searches.length > 0) {
    lines.push(`Searches: ${facts.searches.map(q => `"${q}"`).join(", ")}`);
  }

  return lines.join("\n");
}

// ── Pruner ──────────────────────────────────────────────────────────────────

/** A planned prune: replace messages[startIndex..endIndex] with the summary. */
export interface PrunePlan {
  /** First message index to replace (inclusive). */
  startIndex: number;
  /** Last message index to replace (inclusive). */
  endIndex: number;
  summaryMessage: LlmMessage;
}

/**
 * Plan a prune, keeping the first message (original task) and the last N turn
 * pairs. Returns null when there is nothing worth pruning. The caller applies
 * the plan — the session log records it as a durable replace, so the pruned
 * range survives in the log even though the model no longer sees it.
 */
export function planPrune(messages: LlmMessage[], config?: Partial<PruneConfig>): PrunePlan | null {
  const keepRecent = config?.keepRecentTurns ?? DEFAULT_CONFIG.keepRecentTurns;
  const keepRecentMessages = keepRecent * 2; // each turn = user + assistant

  // Not enough messages to prune
  if (messages.length <= keepRecentMessages + 1) {
    return null;
  }

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
  if (splitIdx <= 1) return null;

  const middle = messages.slice(1, splitIdx);

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

  return {
    startIndex: 1,
    endIndex: splitIdx - 1,
    summaryMessage: { role: "user", content: formatFactSummary(middle, toolsUsed) },
  };
}

/** Prune messages, keeping the first (original task) and last N turn pairs. */
export function pruneMessages(
  messages: LlmMessage[],
  config?: Partial<PruneConfig>,
): LlmMessage[] {
  const plan = planPrune(messages, config);
  if (!plan) return messages;
  return [
    ...messages.slice(0, plan.startIndex),
    plan.summaryMessage,
    ...messages.slice(plan.endIndex + 1),
  ];
}
