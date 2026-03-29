import type { LlmProvider, LlmMessage, AgentToolDef, LlmResponse, ContentBlock, StreamDelta } from "./types.js";

/** Convert Anthropic tool defs to OpenAI function format (Ollama uses OpenAI-compat). */
function toOllamaTools(tools: AgentToolDef[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toOllamaMessages(system: string, messages: LlmMessage[]) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
    } else {
      for (const block of msg.content) {
        if (block.type === "text") {
          out.push({ role: msg.role, content: block.text });
        } else if (block.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.content });
        } else if (block.type === "tool_use") {
          out.push({
            role: "assistant",
            tool_calls: [{ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } }],
          });
        }
      }
    }
  }
  return out;
}

export class OllamaProvider implements LlmProvider {
  name = "ollama";
  contextWindow = 32_000;
  private baseUrl: string;
  private model: string;

  constructor(model?: string, baseUrl?: string) {
    this.baseUrl = baseUrl ?? "http://localhost:11434";
    this.model = model ?? "qwen2.5-coder:14b";
  }

  async chat(system: string, messages: LlmMessage[], tools: AgentToolDef[]): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOllamaMessages(system, messages),
      stream: false,
    };
    if (tools.length > 0) body.tools = toOllamaTools(tools);

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${text}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const message = data.message as Record<string, unknown> | undefined;
    const content: ContentBlock[] = [];

    if (message?.content && typeof message.content === "string") {
      content.push({ type: "text", text: message.content });
    }

    const toolCalls = message?.tool_calls as Record<string, unknown>[] | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, unknown>;
        content.push({
          type: "tool_use",
          id: `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: fn.name as string,
          input: typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments as Record<string, unknown>,
        });
      }
    }

    const stop_reason = toolCalls && toolCalls.length > 0 ? "tool_use" : "end_turn";
    return { content, stop_reason };
  }

  async *chatStream(system: string, messages: LlmMessage[], tools: AgentToolDef[]): AsyncIterable<StreamDelta> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOllamaMessages(system, messages),
      stream: true,
    };
    if (tools.length > 0) body.tools = toOllamaTools(tools);

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${text}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let stopReason: LlmResponse["stop_reason"] = "end_turn";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk: Record<string, unknown>;
        try { chunk = JSON.parse(line); } catch { continue; }

        const message = chunk.message as Record<string, unknown> | undefined;
        if (message?.content && typeof message.content === "string") {
          yield { type: "text_delta", text: message.content };
        }

        // Ollama sends tool_calls in the final message (done=true)
        const tcalls = message?.tool_calls as Record<string, unknown>[] | undefined;
        if (tcalls) {
          stopReason = "tool_use";
          for (const tc of tcalls) {
            const fn = tc.function as Record<string, unknown>;
            const id = `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            yield { type: "tool_use_start", id, name: fn.name as string };
            yield { type: "tool_use_delta", id, json: JSON.stringify(typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments) };
            yield { type: "tool_use_end", id };
          }
        }

        if (chunk.done === true) break;
      }
    }

    yield { type: "done", stop_reason: stopReason };
  }
}
