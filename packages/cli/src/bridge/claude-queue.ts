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
// With nothing queued, `up` recalls the last prompt instead, so the queue is
// read from the transcript's queue rows first, and each step is confirmed by
// the rows Claude writes before the next key goes. The screen read only
// guards the input box: with text in it, `up` moves the cursor and send-now
// would send the draft.
import { open } from "node:fs/promises";
import { BridgeError } from "./protocol.js";
import { claudeInputEmpty, claudeSubagentView } from "./claude-suggestion.js";
import { unwrapPastedContent } from "./transcript-claude.js";

export type ClaudeQueueAction = "send-now" | "withdraw";

export interface ClaudeQueueDeps {
  /** The pane's screen with styles, as `readScreen` with format "ansi" returns it. */
  screen(): Promise<string>;
  sendKeys(keys: string[]): Promise<void>;
  /** An approval, terminal prompt or question the Hook holds for this pane. */
  held(): boolean;
  /** The conversation's transcript text, at least its recent tail. */
  transcript(): Promise<string>;
  sleep(ms: number): Promise<void>;
}

const TAIL_BYTES = 1_048_576;
/** How long Claude has to write the rows that confirm a key, in 100 ms reads. */
const CONFIRM_READS = 30;

/** The last `TAIL_BYTES` of a transcript, from its first whole line. */
export async function transcriptTail(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES), buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally { await handle.close(); }
}

/** The person's messages still in Claude's queue, oldest first, from its
 * queue rows: an `enqueue` joins it; `dequeue` takes the head; `remove` and
 * `popAll` take the message they name. The harness's own envelopes (task
 * notifications, reminders) are left out, as the phone never shows them. */
export function claudeQueued(transcript: string): string[] {
  const queue: string[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.includes('"queue-operation"')) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== "queue-operation" || row.isSidechain) continue;
    const content = typeof row.content === "string" ? row.content : undefined;
    if (row.operation === "enqueue" && content !== undefined) queue.push(content);
    else if (row.operation === "dequeue") queue.shift();
    else if ((row.operation === "remove" || row.operation === "popAll") && content !== undefined) {
      const index = queue.indexOf(content);
      if (index >= 0) queue.splice(index, 1);
    }
  }
  return queue.map(unwrapPastedContent).filter(text => !text.trimStart().startsWith("<"));
}

/** Send Claude's queued messages to the running turn now, or withdraw them
 * all unsent. `status` is the pane's agent status. Answers the messages it
 * acted on, oldest first. */
export async function claudeQueueAction(action: ClaudeQueueAction, status: string, deps: ClaudeQueueDeps): Promise<{ ok: true; messages: string[] }> {
  if (status !== "working") throw new BridgeError(409, "This agent is no longer working, so it has already taken its queued messages.", { code: "queue-idle" });
  const queued = claudeQueued(await deps.transcript());
  if (!queued.length) throw new BridgeError(409, "The agent has no queued messages now; it has already taken them.", { code: "queue-empty" });
  await ready(deps);
  if (action === "send-now") {
    await deps.sendKeys(["ctrl+x", "ctrl+s"]);
    if (!await settled(deps)) throw new BridgeError(409, "Claude did not take its queued messages. This Claude Code may not have send-now, or its keys were changed.", { code: "queue-not-sent" });
    return { ok: true, messages: queued };
  }
  await deps.sendKeys(["up"]);
  // Only once Claude logged the queue as pulled back into the input is the
  // input cleared: an `up` that went anywhere else is left alone.
  if (!await settled(deps)) {
    // The input was empty before `up`; whatever it recalled is not the owner's.
    if (!deps.held()) await deps.sendKeys(["ctrl+l"]);
    throw new BridgeError(409, "Claude did not take its queued messages back. Check the terminal.", { code: "queue-not-withdrawn" });
  }
  if (deps.held()) throw new BridgeError(409, "Claude moved its queued messages into its input box, then asked for input. Clear the box in the terminal.", { code: "queue-not-cleared" });
  await deps.sendKeys(["ctrl+l"]);
  await deps.sleep(250);
  // A remapped key would leave the queued text in the input, where the next
  // Enter in the pane sends it. Say so rather than report it withdrawn.
  if (!claudeInputEmpty(await deps.screen().catch(() => ""))) {
    throw new BridgeError(409, "Claude moved its queued messages into its input box but did not clear it. Clear it in the terminal.", { code: "queue-not-cleared" });
  }
  return { ok: true, messages: queued };
}

async function ready(deps: ClaudeQueueDeps): Promise<void> {
  if (deps.held()) throw new BridgeError(409, "This agent needs input in the terminal first.", { code: "queue-held" });
  const screen = await deps.screen();
  if (claudeSubagentView(screen)) throw new BridgeError(409, "The terminal is showing a subagent. Return to the main conversation there first.", { code: "queue-subagent-view" });
  if (!claudeInputEmpty(screen)) throw new BridgeError(409, "The terminal's input box has text in it. Send or clear it there first.", { code: "queue-input-busy" });
  // A prompt that opened while the screen was read takes the keys instead.
  if (deps.held()) throw new BridgeError(409, "This agent needs input in the terminal first.", { code: "queue-held" });
}

/** Whether the queue emptied: the rows Claude writes for the key landed. */
async function settled(deps: ClaudeQueueDeps): Promise<boolean> {
  for (let read = 0; read < CONFIRM_READS; read++) {
    await deps.sleep(100);
    if (!claudeQueued(await deps.transcript().catch(() => "")).length) return true;
  }
  return false;
}
