import { toOpenAiTools, toOpenAiMessages, parseOpenAiResponse, parseOpenAiStream } from "./openai-compat.js";
export class OpenRouterProvider {
    name = "openrouter";
    contextWindow = 200_000;
    apiKey;
    model;
    baseUrl;
    constructor(apiKey, model, baseUrl) {
        this.apiKey = apiKey;
        this.model = model ?? "anthropic/claude-sonnet-4-20250514";
        this.baseUrl = baseUrl ?? "https://openrouter.ai/api/v1";
    }
    async chat(system, messages, tools) {
        const body = {
            model: this.model,
            messages: toOpenAiMessages(system, messages),
            max_tokens: 8192,
        };
        if (tools.length > 0)
            body.tools = toOpenAiTools(tools);
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
                "HTTP-Referer": "https://github.com/alaarab/phren",
                "X-Title": "phren-agent",
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`OpenRouter API error ${res.status}: ${text}`);
        }
        return parseOpenAiResponse(await res.json());
    }
    async *chatStream(system, messages, tools) {
        const body = {
            model: this.model,
            messages: toOpenAiMessages(system, messages),
            max_tokens: 8192,
            stream: true,
        };
        if (tools.length > 0)
            body.tools = toOpenAiTools(tools);
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
                "HTTP-Referer": "https://github.com/alaarab/phren",
                "X-Title": "phren-agent",
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`OpenRouter API error ${res.status}: ${text}`);
        }
        yield* parseOpenAiStream(res);
    }
}
/** OpenAI-native provider (same protocol, different base URL). */
export class OpenAiProvider {
    name = "openai";
    contextWindow = 128_000;
    apiKey;
    model;
    baseUrl;
    constructor(apiKey, model, baseUrl) {
        this.apiKey = apiKey;
        this.model = model ?? "gpt-4o";
        this.baseUrl = baseUrl ?? "https://api.openai.com/v1";
    }
    async chat(system, messages, tools) {
        const body = {
            model: this.model,
            messages: toOpenAiMessages(system, messages),
            max_tokens: 8192,
        };
        if (tools.length > 0)
            body.tools = toOpenAiTools(tools);
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`OpenAI API error ${res.status}: ${text}`);
        }
        return parseOpenAiResponse(await res.json());
    }
    async *chatStream(system, messages, tools) {
        const body = {
            model: this.model,
            messages: toOpenAiMessages(system, messages),
            max_tokens: 8192,
            stream: true,
        };
        if (tools.length > 0)
            body.tools = toOpenAiTools(tools);
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`OpenAI API error ${res.status}: ${text}`);
        }
        yield* parseOpenAiStream(res);
    }
}
