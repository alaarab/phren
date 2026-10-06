/** The TurnHooks a subagent process uses to relay its turn to the parent over IPC. */
import type { TurnHooks } from "../agent-loop.js";
import type { ChildMessage } from "./types.js";

/** Build TurnHooks that relay all events to the parent via IPC. */
export function createIpcHooks(agentId: string, sendMessage: (msg: ChildMessage) => void): TurnHooks {
  // Characters streamed by the current model call, so a retry can tell the
  // parent how much of its text to drop.
  let attemptChars = 0;
  return {
    onTextDelta(text: string) {
      attemptChars += text.length;
      sendMessage({ type: "text_delta", agentId, text });
    },
    onStreamRetry() {
      sendMessage({ type: "stream_retry", agentId, discard: attemptChars });
      attemptChars = 0;
    },
    onAssistantMessage() {
      attemptChars = 0;
    },
    onTextDone() {
      // No-op — parent reconstructs from deltas
    },
    onTextBlock(text: string) {
      sendMessage({ type: "text_block", agentId, text });
    },
    onToolStart(name: string, input: Record<string, unknown>, count: number) {
      sendMessage({ type: "tool_start", agentId, toolName: name, input, count });
    },
    onToolEnd(name: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number) {
      sendMessage({ type: "tool_end", agentId, toolName: name, input, output, isError, durationMs });
    },
    onStatus(msg: string) {
      sendMessage({ type: "status", agentId, message: msg });
    },
  };
}
