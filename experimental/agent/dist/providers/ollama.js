/** Convert Anthropic tool defs to OpenAI function format (Ollama uses OpenAI-compat). */
function toOllamaTools(tools) {
    return tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
}
function toOllamaMessages(system, messages) {
    const out = [{ role: "system", content: system }];
    for (const msg of messages) {
        if (typeof msg.content === "string") {
            out.push({ role: msg.role, content: msg.content });
        }
        else {
            for (const block of msg.content) {
                if (block.type === "text") {
                    out.push({ role: msg.role, content: block.text });
                }
                else if (block.type === "tool_result") {
                    out.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.content });
                }
                else if (block.type === "tool_use") {
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
export class OllamaProvider {
    name = "ollama";
    contextWindow = 32_000;
    maxOutputTokens;
    baseUrl;
    model;
    constructor(model, baseUrl, maxOutputTokens) {
        this.baseUrl = baseUrl ?? "http://localhost:11434";
        this.model = model ?? "qwen2.5-coder:14b";
        this.maxOutputTokens = maxOutputTokens ?? 8192;
    }
    async chat(system, messages, tools) {
        const body = {
            model: this.model,
            messages: toOllamaMessages(system, messages),
            options: { num_predict: this.maxOutputTokens },
            stream: false,
        };
        if (tools.length > 0)
            body.tools = toOllamaTools(tools);
        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Ollama API error ${res.status}: ${text}`);
        }
        const data = await res.json();
        const message = data.message;
        const content = [];
        if (message?.content && typeof message.content === "string") {
            content.push({ type: "text", text: message.content });
        }
        const toolCalls = message?.tool_calls;
        if (toolCalls) {
            for (let i = 0; i < toolCalls.length; i++) {
                const fn = toolCalls[i].function;
                content.push({
                    type: "tool_use",
                    id: `call_${i}`,
                    name: fn.name,
                    input: typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments,
                });
            }
        }
        const stop_reason = toolCalls && toolCalls.length > 0 ? "tool_use" : "end_turn";
        return { content, stop_reason };
    }
    async *chatStream(system, messages, tools) {
        const body = {
            model: this.model,
            messages: toOllamaMessages(system, messages),
            options: { num_predict: this.maxOutputTokens },
            stream: true,
        };
        if (tools.length > 0)
            body.tools = toOllamaTools(tools);
        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Ollama API error ${res.status}: ${text}`);
        }
        if (!res.body)
            throw new Error("Provider returned empty response body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let stopReason = "end_turn";
        let toolCallIndex = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
                if (!line.trim())
                    continue;
                let chunk;
                try {
                    chunk = JSON.parse(line);
                }
                catch {
                    continue;
                }
                const message = chunk.message;
                if (message?.content && typeof message.content === "string") {
                    yield { type: "text_delta", text: message.content };
                }
                // Ollama sends tool_calls in the final message (done=true)
                const tcalls = message?.tool_calls;
                if (tcalls) {
                    stopReason = "tool_use";
                    for (const tc of tcalls) {
                        const fn = tc.function;
                        const id = `call_${toolCallIndex++}`;
                        yield { type: "tool_use_start", id, name: fn.name };
                        yield { type: "tool_use_delta", id, json: JSON.stringify(typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments) };
                        yield { type: "tool_use_end", id };
                    }
                }
                if (chunk.done === true)
                    break;
            }
        }
        yield { type: "done", stop_reason: stopReason };
    }
}
