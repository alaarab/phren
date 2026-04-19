import { estimateTokens, estimateMessageTokens } from "../context/token-counter.js";
export function createFlushConfig(contextLimit) {
    return { contextLimit, triggered: false };
}
const FLUSH_PROMPT = "Before continuing, briefly summarize the key decisions, patterns, and discoveries from this conversation so far. " +
    "Focus on non-obvious findings that would be valuable to remember in future sessions. " +
    "Be concise — 3-5 bullet points maximum.";
/**
 * Check if a context flush should be injected.
 * Returns the flush message to inject, or null if not needed.
 * Only triggers once per session.
 */
export function checkFlushNeeded(systemPrompt, messages, config) {
    if (config.triggered)
        return null;
    const systemTokens = estimateTokens(systemPrompt);
    const msgTokens = estimateMessageTokens(messages);
    const usage = (systemTokens + msgTokens) / config.contextLimit;
    if (usage >= 0.75) {
        config.triggered = true;
        return FLUSH_PROMPT;
    }
    return null;
}
