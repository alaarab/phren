export function createWebFetchTool() {
    return {
        name: "web_fetch",
        description: "Fetch a URL and return its text content. Use for reading documentation, API references, or web pages. Returns plain text (HTML tags stripped). Max 50KB response.",
        input_schema: {
            type: "object",
            properties: {
                url: { type: "string", description: "The URL to fetch." },
                max_length: { type: "number", description: "Max response length in characters. Default: 50000." },
            },
            required: ["url"],
        },
        async execute(input) {
            const url = input.url;
            const maxLen = input.max_length || 50_000;
            try {
                const res = await fetch(url, {
                    headers: { "User-Agent": "phren-agent/0.1" },
                    signal: AbortSignal.timeout(15_000),
                });
                if (!res.ok)
                    return { output: `HTTP ${res.status}: ${res.statusText}`, is_error: true };
                let text = await res.text();
                // Strip HTML tags for readability
                text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
                text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
                text = text.replace(/<[^>]+>/g, " ");
                text = text.replace(/\s{2,}/g, " ").trim();
                if (text.length > maxLen) {
                    text = text.slice(0, maxLen) + `\n\n[truncated at ${maxLen} chars]`;
                }
                return { output: text };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { output: `Fetch failed: ${msg}`, is_error: true };
            }
        },
    };
}
