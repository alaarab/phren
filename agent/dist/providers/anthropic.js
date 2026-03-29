export class AnthropicProvider {
    name = "anthropic";
    contextWindow = 200_000;
    apiKey;
    model;
    constructor(apiKey, model) {
        this.apiKey = apiKey;
        this.model = model ?? "claude-sonnet-4-20250514";
    }
    async chat(system, messages, tools) {
        const body = {
            model: this.model,
            system,
            messages: messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
            max_tokens: 8192,
        };
        if (tools.length > 0) {
            body.tools = tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.input_schema,
            }));
        }
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": this.apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Anthropic API error ${res.status}: ${text}`);
        }
        const data = await res.json();
        const content = data.content ?? [];
        const stop_reason = data.stop_reason === "tool_use" ? "tool_use"
            : data.stop_reason === "max_tokens" ? "max_tokens"
                : "end_turn";
        const usage = data.usage;
        return {
            content,
            stop_reason: stop_reason,
            usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined,
        };
    }
    async *chatStream(system, messages, tools) {
        const body = {
            model: this.model,
            system,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            max_tokens: 8192,
            stream: true,
        };
        if (tools.length > 0) {
            body.tools = tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.input_schema,
            }));
        }
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": this.apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Anthropic API error ${res.status}: ${text}`);
        }
        let stopReason = "end_turn";
        let usage;
        for await (const event of parseSSE(res)) {
            const type = event.event;
            const data = event.data;
            if (type === "content_block_start") {
                const block = data.content_block;
                if (block.type === "tool_use") {
                    yield { type: "tool_use_start", id: block.id, name: block.name };
                }
            }
            else if (type === "content_block_delta") {
                const delta = data.delta;
                if (delta.type === "text_delta") {
                    yield { type: "text_delta", text: delta.text };
                }
                else if (delta.type === "input_json_delta") {
                    const index = data.index;
                    yield { type: "tool_use_delta", id: String(index), json: delta.partial_json };
                }
            }
            else if (type === "content_block_stop") {
                // The block at data.index may be a tool — emit tool_use_end
                yield { type: "tool_use_end", id: String(data.index) };
            }
            else if (type === "message_delta") {
                const delta = data.delta;
                if (delta.stop_reason === "tool_use")
                    stopReason = "tool_use";
                else if (delta.stop_reason === "max_tokens")
                    stopReason = "max_tokens";
                const u = data.usage;
                if (u) {
                    usage = {
                        input_tokens: u.input_tokens ?? 0,
                        output_tokens: u.output_tokens ?? 0,
                    };
                }
            }
            else if (type === "message_start") {
                const u = data.message?.usage;
                if (u) {
                    usage = {
                        input_tokens: u.input_tokens ?? 0,
                        output_tokens: u.output_tokens ?? 0,
                    };
                }
            }
        }
        yield { type: "done", stop_reason: stopReason, usage };
    }
}
/** Parse SSE stream from a fetch Response. */
async function* parseSSE(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let currentEvent = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
            if (line.startsWith("event: ")) {
                currentEvent = line.slice(7).trim();
            }
            else if (line.startsWith("data: ")) {
                const raw = line.slice(6);
                if (raw === "[DONE]")
                    return;
                try {
                    yield { event: currentEvent, data: JSON.parse(raw) };
                }
                catch { /* skip malformed JSON */ }
            }
        }
    }
}
