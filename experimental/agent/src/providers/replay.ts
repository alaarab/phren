/**
 * Replay provider: turns any recorded session event log into a scripted,
 * keyless LLM. Each `assistant/message` event in the log becomes one chat
 * response, replayed in order — so a real session (every run records one for
 * free) becomes a deterministic regression test with zero API cost.
 *
 * Set PHREN_AGENT_REPLAY=<path-to-events.jsonl> to run the agent against a
 * recording instead of a live provider.
 */
import type { AgentToolDef, LlmMessage, LlmProvider, LlmResponse, ContentBlock } from "./types.js";
import { loadEventLog } from "../session/persist.js";
import type { SessionEvent } from "../session/log.js";

export class ReplayExhaustedError extends Error {
  constructor(requests: number, scripted: number) {
    super(
      `Replay exhausted: the loop made request #${requests} but the recording only has ${scripted} assistant response(s). ` +
      "The conversation diverged from the recorded session.",
    );
  }
}

interface ScriptedResponse {
  content: ContentBlock[];
  stop_reason: LlmResponse["stop_reason"];
  usage?: LlmResponse["usage"];
}

function toStopReason(raw: string): LlmResponse["stop_reason"] {
  return raw === "tool_use" || raw === "max_tokens" ? raw : "end_turn";
}

function scriptFromEvents(events: readonly SessionEvent[]): ScriptedResponse[] {
  const script: ScriptedResponse[] = [];
  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    const data = event.data as { message: LlmMessage; stop_reason: string; usage?: LlmResponse["usage"] };
    const content: ContentBlock[] = typeof data.message.content === "string"
      ? [{ type: "text", text: data.message.content }]
      : data.message.content;
    script.push({ content, stop_reason: toStopReason(data.stop_reason), usage: data.usage });
  }
  return script;
}

export class ReplayProvider implements LlmProvider {
  name = "replay";
  model: string;
  contextWindow = 200_000;

  private script: ScriptedResponse[];
  private cursor = 0;
  /** Every request the loop made, for post-run assertions. */
  readonly requests: Array<{ system: string; messages: LlmMessage[]; toolCount: number }> = [];

  constructor(script: ScriptedResponse[], sourceLabel = "inline") {
    this.script = script;
    this.model = `replay:${sourceLabel}`;
  }

  static fromEventLog(file: string): ReplayProvider {
    const { header, events } = loadEventLog(file);
    return new ReplayProvider(scriptFromEvents(events), header.sessionId);
  }

  static fromMessages(assistantMessages: Array<{ content: ContentBlock[]; stop_reason?: LlmResponse["stop_reason"] }>): ReplayProvider {
    return new ReplayProvider(
      assistantMessages.map((m) => ({ content: m.content, stop_reason: m.stop_reason ?? "end_turn" })),
    );
  }

  /** Responses remaining in the script. */
  get remaining(): number {
    return this.script.length - this.cursor;
  }

  async chat(system: string, messages: LlmMessage[], tools: AgentToolDef[]): Promise<LlmResponse> {
    this.requests.push({ system, messages, toolCount: tools.length });
    if (this.cursor >= this.script.length) {
      throw new ReplayExhaustedError(this.requests.length, this.script.length);
    }
    const next = this.script[this.cursor++];
    return { content: next.content, stop_reason: next.stop_reason, usage: next.usage };
  }

  /** Throws unless every scripted response was consumed exactly once. */
  assertFullyConsumed(): void {
    if (this.cursor !== this.script.length) {
      throw new Error(
        `Replay incomplete: ${this.cursor}/${this.script.length} scripted responses consumed. ` +
        "The loop made fewer requests than the recorded session.",
      );
    }
  }
}
