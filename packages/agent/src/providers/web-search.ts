import type { TokenUsage } from "./types.js";
export interface WebSearchSource { title: string; url: string; snippet: string }
export interface WebSearchResponse { answer?: string; sources: WebSearchSource[]; usage?: TokenUsage; billedCost?: number }
/** Only public HTTP(S) citations, deduplicated. Never return encrypted provider payloads. */
export function searchSources(raw: unknown[], limit: number): WebSearchSource[] {
  const sources = new Map<string, WebSearchSource>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    try {
      const url = new URL(String(item.url));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
      const href = url.href;
      if (!sources.has(href)) sources.set(href, { title: typeof item.title === "string" ? item.title.slice(0, 300) : url.hostname, url: href, snippet: typeof item.snippet === "string" ? item.snippet.slice(0, 2000) : typeof item.cited_text === "string" ? item.cited_text.slice(0, 2000) : "" });
    } catch { /* Invalid citation URL. */ }
    if (sources.size >= limit) break;
  }
  return [...sources.values()];
}
