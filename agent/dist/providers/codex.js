import { getAccessToken } from "./codex-auth.js";
const CODEX_API = "https://chatgpt.com/backend-api/codex/responses";
/** Convert our tool defs to Responses API tool format. */
function toResponsesTools(tools) {
    return tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
    }));
}
/** Convert our messages to Responses API input format. */
function toResponsesInput(system, messages) {
    const input = [];
    for (const msg of messages) {
        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                input.push({
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: msg.content }],
                });
            }
            else {
                // tool_result blocks
                for (const block of msg.content) {
                    if (block.type === "tool_result") {
                        input.push({
                            type: "function_call_output",
                            call_id: block.tool_use_id,
                            output: block.content,
                        });
                    }
                    else if (block.type === "text") {
                        input.push({
                            type: "message",
                            role: "user",
                            content: [{ type: "input_text", text: block.text }],
                        });
                    }
                }
            }
        }
        else if (msg.role === "assistant") {
            if (typeof msg.content === "string") {
                input.push({
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: msg.content }],
                });
            }
            else {
                for (const block of msg.content) {
                    if (block.type === "text") {
                        input.push({
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: block.text }],
                        });
                    }
                    else if (block.type === "tool_use") {
                        input.push({
                            type: "function_call",
                            call_id: block.id,
                            name: block.name,
                            arguments: JSON.stringify(block.input),
                        });
                    }
                }
            }
        }
    }
    return input;
}
/** Parse non-streaming Responses API output into our ContentBlock format. */
function parseResponsesOutput(data) {
    const output = data.output;
    const content = [];
    let hasToolUse = false;
    if (output) {
        for (const item of output) {
            if (item.type === "message") {
                const msgContent = item.content;
                if (msgContent) {
                    for (const c of msgContent) {
                        if (c.type === "output_text" && c.text) {
                            content.push({ type: "text", text: c.text });
                        }
                    }
                }
            }
            else if (item.type === "function_call") {
                hasToolUse = true;
                content.push({
                    type: "tool_use",
                    id: item.call_id,
                    name: item.name,
                    input: JSON.parse(item.arguments),
                });
            }
        }
    }
    const status = data.status;
    const stop_reason = hasToolUse ? "tool_use"
        : status === "incomplete" ? "max_tokens"
            : "end_turn";
    const usage = data.usage;
    return {
        content,
        stop_reason,
        usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined,
    };
}
export class CodexProvider {
    name = "codex";
    contextWindow = 128_000;
    model;
    constructor(model) {
        this.model = model ?? "gpt-5.2-codex";
    }
    async chat(system, messages, tools) {
        const { accessToken } = await getAccessToken();
        const body = {
            model: this.model,
            instructions: system,
            input: toResponsesInput(system, messages),
            store: false,
            stream: true,
        };
        if (tools.length > 0) {
            body.tools = toResponsesTools(tools);
            body.tool_choice = "auto";
        }
        const bodyStr = JSON.stringify(body);
        const res = await fetch(CODEX_API, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
            },
            body: bodyStr,
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Codex API error ${res.status}: ${text}`);
        }
        // Stream is mandatory for Codex backend — consume it and collect the final response
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const events = [];
        let finalResponse = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith("data: "))
                    continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]")
                    continue;
                events.push(data);
                try {
                    const event = JSON.parse(data);
                    if (event.type === "response.completed" && event.response) {
                        finalResponse = event.response;
                    }
                }
                catch { /* skip */ }
            }
        }
        // Dump first 20 events for debugging
        if (finalResponse)
            return parseResponsesOutput(finalResponse);
        // Fallback: try to extract from accumulated events
        return { content: [], stop_reason: "end_turn" };
    }
    async *chatStream(system, messages, tools) {
        const { accessToken } = await getAccessToken();
        const body = {
            model: this.model,
            instructions: system,
            input: toResponsesInput(system, messages),
            store: false,
            stream: true,
            include: ["reasoning.encrypted_content"],
        };
        if (tools.length > 0) {
            body.tools = toResponsesTools(tools);
            body.tool_choice = "auto";
        }
        const res = await fetch(CODEX_API, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Codex API error ${res.status}: ${text}`);
        }
        // Parse SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let activeToolCallId = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith("data: "))
                    continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]")
                    return;
                let event;
                try {
                    event = JSON.parse(data);
                }
                catch {
                    continue;
                }
                const type = event.type;
                if (type === "response.output_text.delta") {
                    yield { type: "text_delta", text: event.delta };
                }
                else if (type === "response.output_item.added") {
                    if (event.item?.type === "function_call") {
                        const item = event.item;
                        activeToolCallId = item.call_id;
                        yield { type: "tool_use_start", id: activeToolCallId, name: item.name };
                    }
                }
                else if (type === "response.function_call_arguments.delta") {
                    yield { type: "tool_use_delta", id: activeToolCallId, json: event.delta };
                }
                else if (type === "response.function_call_arguments.done") {
                    yield { type: "tool_use_end", id: activeToolCallId };
                }
                else if (type === "response.completed") {
                    const response = event.response;
                    const usage = response?.usage;
                    const output = response?.output;
                    const hasToolCalls = output?.some((o) => o.type === "function_call");
                    yield {
                        type: "done",
                        stop_reason: hasToolCalls ? "tool_use" : "end_turn",
                        usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined,
                    };
                }
            }
        }
    }
}
