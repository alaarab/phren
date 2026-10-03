import type { TokenUsage } from "./types.js";
export interface WebSearchSource { title: string; url: string; snippet: string }
export interface WebSearchResponse { answer?: string; sources: WebSearchSource[]; usage?: TokenUsage; billedCost?: number }
/** Only public HTTP(S) citations, deduplicated. Never return encrypted provider payloads. */
export function searchSources(raw: unknown[], limit: number): WebSearchSource[] {
  if (!Array.isArray(raw) || !Number.isFinite(limit) || limit < 1) return [];
  limit = Math.min(10, Math.floor(limit));
  const sources = new Map<string, WebSearchSource>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    try {
      const url = new URL(String(item.url));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /^(?:localhost|127\.|0\.|169\.254\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[::1\]|\[f[cd][0-9a-f])/i.test(url.hostname)) continue;
      const href = url.href;
      if (!sources.has(href)) sources.set(href, { title: typeof item.title === "string" ? item.title.slice(0, 300) : url.hostname, url: href, snippet: typeof item.snippet === "string" ? item.snippet.slice(0, 2000) : typeof item.cited_text === "string" ? item.cited_text.slice(0, 2000) : "" });
    } catch { /* Invalid citation URL. */ }
    if (sources.size >= limit) break;
  }
  return [...sources.values()];
}

/** Bound response parsing before arbitrary provider data enters model context. */
export async function searchJson(response: Response): Promise<Record<string, any>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Search response has no body.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024) throw new Error("Search response exceeded the size limit.");
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid search response.");
    return data;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Billed usage must survive an HTTP-200 tool failure without echoing its body. */
export class SearchResponseError extends Error {
  constructor(message: string, readonly usage?: TokenUsage, readonly billedCost?: number) { super(message); }
}
export function searchTokenUsage(raw: unknown, inputKey = "input_tokens", outputKey = "output_tokens"): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const count = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0 ? value[key] as number : 0;
  return { input_tokens: count(inputKey), output_tokens: count(outputKey) };
}
