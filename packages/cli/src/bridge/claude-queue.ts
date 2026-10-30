// Messages a busy Claude Code pane holds in its own queue: text typed (or sent
// from the phone) mid-turn waits there, drawn under the input box, until the
// next tool boundary or the end of the turn. Claude Code acts on the whole
// queue, never on one message, through its default chat keys (2.1.312):
//   - `ctrl+x ctrl+s` (chat:sendNow) on an empty input hands every queued
//     message to the running turn now, moving a running tool to the
//     background: `remove` rows with reason `absorbed_mid_turn`.
//   - `up` (history:previous) on an empty input pulls every queued message
//     back into the input (`popAll` rows), and `ctrl+l` (chat:clearInput)
//     clears it. The turn keeps running and the agent never sees them.
// Both need an empty input box: with text in it, `up` moves the cursor and
// send-now would send the draft. The transcript rows these keys write are what
// settle or drop the phone's queued bubbles.
import { BridgeError } from "./protocol.js";
import { claudeInputEmpty, claudeSubagentView } from "./claude-suggestion.js";

export type ClaudeQueueAction = "send-now" | "withdraw";

export interface ClaudeQueueDeps {
  /** The pane's screen with styles, as `readScreen` with format "ansi" returns it. */
  screen(): Promise<string>;
  sendKeys(keys: string[]): Promise<void>;
  /** An approval, terminal prompt or question the Hook holds for this pane. */
  held(): boolean;
  sleep(ms: number): Promise<void>;
}

const KEYS: Record<ClaudeQueueAction, string[][]> = {
  "send-now": [["ctrl+x", "ctrl+s"]],
  withdraw: [["up"], ["ctrl+l"]],
};

/** Send Claude's queued messages to the running turn now, or withdraw them
 * all unsent. `status` is the pane's agent status. */
export async function claudeQueueAction(action: ClaudeQueueAction, status: string, deps: ClaudeQueueDeps): Promise<{ ok: true }> {
  if (status !== "working") throw new BridgeError(409, "This agent is no longer working, so it has already taken its queued messages.", { code: "queue-idle" });
  if (deps.held()) throw new BridgeError(409, "This agent needs input in the terminal first.", { code: "queue-held" });
  const before = await deps.screen();
  if (claudeSubagentView(before)) throw new BridgeError(409, "The terminal is showing a subagent. Return to the main conversation there first.", { code: "queue-subagent-view" });
  if (!claudeInputEmpty(before)) throw new BridgeError(409, "The terminal's input box has text in it. Send or clear it there first.", { code: "queue-input-busy" });
  const [first, ...rest] = KEYS[action];
  await deps.sendKeys(first);
  for (const keys of rest) { await deps.sleep(250); await deps.sendKeys(keys); }
  if (action === "withdraw") {
    // A remapped key would leave the queued text in the input, where the next
    // Enter in the pane sends it. Say so rather than report it withdrawn.
    await deps.sleep(250);
    if (!claudeInputEmpty(await deps.screen().catch(() => ""))) {
      throw new BridgeError(409, "Claude moved its queued messages into its input box but did not clear it. Clear it in the terminal.", { code: "queue-not-cleared" });
    }
  }
  return { ok: true };
}
