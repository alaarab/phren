export class AnthropicProvider {
    name = "anthropic";
    contextWindow = 200_000;
    maxOutputTokens;
    apiKey;
    model;
    cacheEnabled;
    constructor(apiKey, model, maxOutputTokens, cacheEnabled = true) {
        this.apiKey = apiKey;
        this.model = model ?? "claude-sonnet-4-20250514";
        this.maxOutputTokens = maxOutputTokens ?? 8192;
        this.cacheEnabled = cacheEnabled;
    }
    async chat(system, messages, tools) {
        const body = this.buildRequestBody(system, messages, tools);
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
        logCacheUsage(usage);
        return {
            content,
            stop_reason: stop_reason,
            usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined,
        };
    }
    async *chatStream(system, messages, tools) {
        const body = this.buildRequestBody(system, messages, tools);
        body.stream = true;
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
        // Map block index to tool ID for consistent ID across start/delta/end
        const indexToToolId = new Map();
        for await (const event of parseSSE(res)) {
            const type = event.event;
            const data = event.data;
            if (type === "content_block_start") {
                const block = data.content_block;
                if (block.type === "tool_use") {
                    const index = data.index;
                    const id = block.id;
                    indexToToolId.set(index, id);
                    yield { type: "tool_use_start", id, name: block.name };
                }
            }
            else if (type === "content_block_delta") {
                const delta = data.delta;
                if (delta.type === "text_delta") {
                    yield { type: "text_delta", text: delta.text };
                }
                else if (delta.type === "input_json_delta") {
                    const index = data.index;
                    const id = indexToToolId.get(index) ?? String(index);
                    yield { type: "tool_use_delta", id, json: delta.partial_json };
                }
            }
            else if (type === "content_block_stop") {
                const index = data.index;
                if (indexToToolId.has(index)) {
                    yield { type: "tool_use_end", id: indexToToolId.get(index) };
                }
            }
            else if (type === "message_delta") {
                const delta = data.delta;
                if (delta.stop_reason === "tool_use")
                    stopReason = "tool_use";
                else if (delta.stop_reason === "max_tokens")
                    stopReason = "max_tokens";
                // message_delta carries output_tokens — merge with existing input_tokens from message_start
                const u = data.usage;
                if (u) {
                    usage = {
                        input_tokens: usage?.input_tokens ?? 0,
                        output_tokens: u.output_tokens ?? 0,
                    };
                }
            }
            else if (type === "message_start") {
                // message_start carries input_tokens — initialize usage
                const u = data.message?.usage;
                if (u) {
                    logCacheUsage(u);
                    usage = {
                        input_tokens: u.input_tokens ?? 0,
                        output_tokens: usage?.output_tokens ?? 0,
                    };
                }
            }
        }
        yield { type: "done", stop_reason: stopReason, usage };
    }
    /** Build the request body with optional prompt caching breakpoints. */
    buildRequestBody(system, messages, tools) {
        const cache = { cache_control: { type: "ephemeral" } };
        // System prompt: use content array format with cache_control on the text block
        const systemValue = this.cacheEnabled
            ? [{ type: "text", text: system, ...cache }]
            : system;
        const mappedMessages = messages.map((m) => ({ role: m.role, content: m.content }));
        // Mark the last 2 user messages with cache_control for recent-context caching
        if (this.cacheEnabled) {
            let marked = 0;
            for (let i = mappedMessages.length - 1; i >= 0 && marked < 2; i--) {
                if (mappedMessages[i].role !== "user")
                    continue;
                const c = mappedMessages[i].content;
                if (typeof c === "string") {
                    mappedMessages[i] = {
                        role: "user",
                        content: [{ type: "text", text: c, ...cache }],
                    };
                }
                else if (Array.isArray(c) && c.length > 0) {
                    // Add cache_control to the last block of the content array
                    const blocks = [...c];
                    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], ...cache };
                    mappedMessages[i] = { role: "user", content: blocks };
                }
                marked++;
            }
        }
        const body = {
            model: this.model,
            system: systemValue,
            messages: mappedMessages,
            max_tokens: this.maxOutputTokens,
        };
        if (tools.length > 0) {
            const mappedTools = tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.input_schema,
            }));
            // Cache the last tool definition — Anthropic uses it as the breakpoint for the entire tools block
            if (this.cacheEnabled) {
                mappedTools[mappedTools.length - 1] = { ...mappedTools[mappedTools.length - 1], ...cache };
            }
            body.tools = mappedTools;
        }
        return body;
    }
}
/** Log cache hit/creation stats to stderr (visible in verbose mode). */
function logCacheUsage(usage) {
    if (!usage)
        return;
    const created = usage.cache_creation_input_tokens;
    const read = usage.cache_read_input_tokens;
    if (created || read) {
        process.stderr.write(`[cache] created=${created ?? 0} read=${read ?? 0} input=${usage.input_tokens ?? 0}\n`);
    }
}
/** Parse SSE stream from a fetch Response. */
async function* parseSSE(res) {
    if (!res.body)
        throw new Error("Provider returned empty response body");
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
