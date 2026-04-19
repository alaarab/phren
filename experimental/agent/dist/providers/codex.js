import { getAccessToken } from "./codex-auth.js";
import { lookupMaxOutputTokens } from "../models.js";
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
function toResponsesInput(messages) {
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
const DEBUG = process.env.PHREN_DEBUG === "1";
function debugLog(label, data) {
    if (!DEBUG)
        return;
    process.stderr.write(`[codex:debug] ${label}: ${JSON.stringify(data, null, 2)}\n`);
}
/** Parse non-streaming Responses API output into our ContentBlock format. */
function parseResponsesOutput(data) {
    debugLog("parseResponsesOutput input", data);
    // The Responses API may return output at top-level or nested under a "response" key.
    // Handle both shapes defensively.
    const root = (data.output !== undefined ? data : data.response ?? data);
    const output = root.output;
    const content = [];
    let hasToolUse = false;
    if (output) {
        for (const item of output) {
            debugLog("output item", item);
            if (item.type === "message") {
                // Content may be an array of blocks or a plain string
                const msgContent = item.content;
                if (Array.isArray(msgContent)) {
                    for (const c of msgContent) {
                        if ((c.type === "output_text" || c.type === "text") && c.text) {
                            content.push({ type: "text", text: c.text });
                        }
                    }
                }
                else if (typeof msgContent === "string" && msgContent) {
                    content.push({ type: "text", text: msgContent });
                }
            }
            else if (item.type === "function_call") {
                hasToolUse = true;
                let input = {};
                const rawArgs = item.arguments;
                if (rawArgs) {
                    try {
                        input = JSON.parse(rawArgs);
                    }
                    catch { /* malformed arguments */ }
                }
                const callId = (item.call_id ?? item.id);
                content.push({
                    type: "tool_use",
                    id: callId,
                    name: item.name,
                    input,
                });
            }
            else if (item.type === "reasoning") {
                // Reasoning items are informational — skip them, they don't map to content blocks
                debugLog("skipping reasoning item", { id: item.id });
            }
        }
    }
    else {
        debugLog("no output array found in response", { keys: Object.keys(data) });
    }
    const status = (root.status ?? data.status);
    const stop_reason = hasToolUse ? "tool_use"
        : status === "incomplete" ? "max_tokens"
            : "end_turn";
    const usage = (root.usage ?? data.usage);
    debugLog("parseResponsesOutput result", { content, stop_reason, usage });
    return {
        content,
        stop_reason,
        usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined,
    };
}
export class CodexProvider {
    name = "openai-codex";
    contextWindow = 1_050_000;
    maxOutputTokens;
    model;
    reasoningEffort;
    constructor(model, maxOutputTokens, reasoningEffort) {
        this.model = model ?? "gpt-5.4";
        this.maxOutputTokens = maxOutputTokens ?? lookupMaxOutputTokens(this.model, this.name);
        this.reasoningEffort = reasoningEffort;
    }
    async chat(system, messages, tools) {
        const { accessToken } = await getAccessToken();
        const body = {
            model: this.model,
            instructions: system,
            input: toResponsesInput(messages),
            store: false,
            stream: true,
        };
        if (this.reasoningEffort) {
            body.reasoning = { effort: this.reasoningEffort };
        }
        if (tools.length > 0) {
            body.tools = toResponsesTools(tools);
            body.tool_choice = "auto";
        }
        return parseResponsesOutput(await this.requestResponse(accessToken, body));
    }
    async *chatStream(system, messages, tools) {
        const { accessToken } = await getAccessToken();
        const body = {
            model: this.model,
            instructions: system,
            input: toResponsesInput(messages),
            store: false,
            stream: true,
            include: ["reasoning.encrypted_content"],
        };
        if (this.reasoningEffort) {
            body.reasoning = { effort: this.reasoningEffort };
        }
        if (tools.length > 0) {
            body.tools = toResponsesTools(tools);
            body.tool_choice = "auto";
        }
        // OpenClaw treats transport as auto: try WebSocket first, then fall back to the
        // HTTP responses stream if the WS path is unavailable.
        try {
            yield* this.chatStreamWs(accessToken, body);
        }
        catch {
            const response = await this.requestResponse(accessToken, body);
            const parsed = parseResponsesOutput(response);
            for (const block of parsed.content) {
                if (block.type === "text") {
                    yield { type: "text_delta", text: block.text };
                }
                else if (block.type === "tool_use") {
                    yield { type: "tool_use_start", id: block.id, name: block.name };
                    yield { type: "tool_use_delta", id: block.id, json: JSON.stringify(block.input) };
                    yield { type: "tool_use_end", id: block.id };
                }
            }
            yield { type: "done", stop_reason: parsed.stop_reason, usage: parsed.usage };
        }
    }
    async requestResponse(accessToken, body) {
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
        if (!res.body)
            throw new Error("Provider returned empty response body");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalResponse = null;
        const seenEventTypes = new Set();
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
                try {
                    const event = JSON.parse(data);
                    const evType = event.type;
                    if (evType)
                        seenEventTypes.add(evType);
                    debugLog("SSE event", { type: evType });
                    // Accept response.completed or response.done (API may use either)
                    if ((evType === "response.completed" || evType === "response.done") &&
                        event.response) {
                        finalResponse = event.response;
                    }
                    else if (evType === "response.completed" || evType === "response.done") {
                        // Response data at the top level (no nested .response key)
                        if (event.output !== undefined || event.status !== undefined) {
                            finalResponse = event;
                        }
                    }
                }
                catch { /* skip malformed events */ }
            }
        }
        if (!finalResponse) {
            debugLog("no finalResponse found, seenEventTypes", [...seenEventTypes]);
        }
        if (!finalResponse) {
            throw new Error("Codex stream ended without response.completed event");
        }
        return finalResponse;
    }
    /** WebSocket streaming — sends request, yields deltas as they arrive. */
    async *chatStreamWs(accessToken, body) {
        const wsUrl = CODEX_API.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
        // Queue for events received from the WebSocket before the consumer pulls them
        const queue = [];
        let resolve = null;
        let done = false;
        const push = (item) => {
            queue.push(item);
            if (resolve) {
                resolve();
                resolve = null;
            }
        };
        // Node.js (undici) WebSocket accepts headers in the second argument object,
        // but the DOM typings only allow string | string[]. Cast to bypass.
        const ws = new WebSocket(wsUrl, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });
        let activeToolCallId = "";
        ws.addEventListener("open", () => {
            // Wrap the request body in a response.create envelope (Codex WS protocol)
            const wsRequest = { type: "response.create", ...body };
            ws.send(JSON.stringify(wsRequest));
        });
        ws.addEventListener("message", (evt) => {
            const data = typeof evt.data === "string" ? evt.data : String(evt.data);
            let event;
            try {
                event = JSON.parse(data);
            }
            catch {
                return;
            }
            const type = event.type;
            // Handle server-side errors
            if (type === "error") {
                const err = event.error;
                const msg = err?.message ?? "Codex WebSocket error";
                const status = event.status;
                push(new Error(`Codex WS error${status ? ` ${status}` : ""}: ${msg}`));
                done = true;
                try {
                    ws.close();
                }
                catch { /* ignore */ }
                return;
            }
            if (type === "response.output_text.delta") {
                const delta = event.delta;
                if (delta)
                    push({ type: "text_delta", text: delta });
            }
            else if (type === "response.output_item.added") {
                if (event.item?.type === "function_call") {
                    const item = event.item;
                    activeToolCallId = item.call_id;
                    push({ type: "tool_use_start", id: activeToolCallId, name: item.name });
                }
            }
            else if (type === "response.function_call_arguments.delta") {
                push({ type: "tool_use_delta", id: activeToolCallId, json: event.delta });
            }
            else if (type === "response.function_call_arguments.done") {
                push({ type: "tool_use_end", id: activeToolCallId });
            }
            else if (type === "response.completed") {
                const response = event.response;
                const usage = response?.usage;
                const output = response?.output;
                const hasToolCalls = output?.some((o) => o.type === "function_call");
                push({
                    type: "done",
                    stop_reason: hasToolCalls ? "tool_use" : "end_turn",
                    usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined,
                });
                done = true;
                try {
                    ws.close();
                }
                catch { /* ignore */ }
            }
        });
        ws.addEventListener("error", () => {
            if (!done) {
                push(new Error("Codex WebSocket connection error"));
                done = true;
            }
        });
        ws.addEventListener("close", () => {
            if (!done) {
                push(new Error("Codex WebSocket closed before response.completed"));
                done = true;
            }
        });
        // Async iteration: drain the queue, wait for new events
        try {
            while (true) {
                while (queue.length > 0) {
                    const item = queue.shift();
                    if (item instanceof Error)
                        throw item;
                    yield item;
                    if (item.type === "done")
                        return;
                }
                if (done)
                    return;
                await new Promise((r) => { resolve = r; });
            }
        }
        finally {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                try {
                    ws.close();
                }
                catch { /* ignore */ }
            }
        }
    }
}
