// Who wrote a prompt: the owner, or another agent or the harness relaying something into the session.

import { classifyClaudePromptText } from "../bridge/input-classification.js";

// Another agent's message relayed into this session: a sub-agent hand-back, a
// message from another session, or the harness's idle or delivery notice.
const AGENT_RELAY_PROMPT_RE = /^\s*(?:<(?:agent-message|cross-session-message)\b|\[Cross-session (?:delivery|idle) notice\])/i;

/** A prompt nobody typed: a background agent's result, a teammate's message,
 *  another agent's report or a harness notice. Recall answers none of them. */
export function isMachinePrompt(prompt: string): boolean {
  return classifyClaudePromptText(prompt).category === "notification" || AGENT_RELAY_PROMPT_RE.test(prompt);
}
