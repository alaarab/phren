import { estimateTokens, estimateMessageTokens } from "./token-counter.js";
const DEFAULT_CONFIG = {
    contextLimit: 200_000,
    keepRecentTurns: 6,
};
/** Returns true when the conversation is approaching context limits. */
export function shouldPrune(systemPrompt, messages, config) {
    const limit = config?.contextLimit ?? DEFAULT_CONFIG.contextLimit;
    const systemTokens = estimateTokens(systemPrompt);
    const msgTokens = estimateMessageTokens(messages);
    return (systemTokens + msgTokens) > limit * 0.75;
}
/** Prune messages, keeping the first (original task) and last N turn pairs. */
export function pruneMessages(messages, config) {
    const keepRecent = config?.keepRecentTurns ?? DEFAULT_CONFIG.keepRecentTurns;
    const keepRecentMessages = keepRecent * 2; // each turn = user + assistant
    // Not enough messages to prune
    if (messages.length <= keepRecentMessages + 1) {
        return messages;
    }
    const first = messages[0]; // original task
    const middle = messages.slice(1, messages.length - keepRecentMessages);
    const tail = messages.slice(messages.length - keepRecentMessages);
    // Collect tool names used in the pruned middle section
    const toolsUsed = new Set();
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
    const summaryMessage = {
        role: "user",
        content: summaryText,
    };
    return [first, summaryMessage, ...tail];
}
