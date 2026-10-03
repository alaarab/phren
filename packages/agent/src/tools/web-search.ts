/**
 * Web search tool — search the web for documentation, error messages, APIs.
 *
 * Uses DuckDuckGo HTML search (no API key required) as the default backend.
 * Falls back gracefully if the search fails.
 */
import { recordTokenUsage, type CostTracker } from "../cost.js";
import type { LlmProvider } from "../providers/types.js";
import type { AgentTool } from "./types.js";

export function createWebSearchTool(options: { provider?: () => LlmProvider; costTracker?: () => CostTracker | null | undefined; network?: () => boolean } = {}): AgentTool {
  return {
    name: "web_search",
    description:
      "Search the web for documentation, error messages, library APIs, or any technical information. " +
      "Returns a list of search results with titles, URLs, and snippets. " +
      "Use this when you need external information not available in the codebase or phren knowledge base.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Be specific — include error messages, library names, or version numbers.",
        },
        limit: {
          type: "number",
          description: "Max results to return. Default: 5.",
        },
      },
      required: ["query"],
    },
    async execute(input, signal) {
      if (options.network?.() === false) return { output: "Web search is disabled by --no-network.", is_error: true, permissionDenied: true };
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 4000) return { output: "query must contain 1–4000 characters.", is_error: true };
      const query = input.query.trim();
      const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? Math.max(1, Math.min(Math.floor(input.limit), 10)) : 5;

      try {
        const provider = options.provider?.(), tracker = options.costTracker?.();
        if (tracker?.isOverBudget()) return { output: "Search stopped: the session budget has been reached.", is_error: true };
        const native = provider?.searchWeb && provider.supportsWebSearch?.();
        const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
        const response = native ? await provider!.searchWeb!(query, limit, timeout) : undefined;
        if (response?.usage && tracker) {
          const priorCost = tracker.totalCost;
          recordTokenUsage(tracker, response.usage);
          if (typeof response.billedCost === "number" && Number.isFinite(response.billedCost) && response.billedCost >= 0) { tracker.totalCost = priorCost + response.billedCost; tracker.metered = true; }
        }
        const results = response?.sources ?? await searchDuckDuckGo(query, limit, timeout);
        const answer = response?.answer ? `Provider search (${provider!.name}):\n${response.answer}\n\n` : "";
        if (results.length === 0) {
          return { output: answer + "No source URLs returned; this answer has no verified citations." };
        }

        const formatted = results.map((r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`
        ).join("\n\n");

        return { output: answer + formatted };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Search failed: ${msg}`, is_error: true };
      }
    },
  };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "phren-agent/0.1 (search tool)",
      "Accept": "text/html",
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Search returned HTTP ${res.status}`);
  }

  const html = await res.text();
  return parseSearchResults(html, limit);
}

function parseSearchResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results are in <div class="result"> blocks
  // Extract links and snippets using regex (no DOM parser dependency)
  const resultBlocks = html.match(/<div class="links_main[\s\S]*?<\/div>\s*<\/div>/gi) || [];

  for (const block of resultBlocks) {
    if (results.length >= limit) break;

    // Extract URL from the result link
    const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>/i);
    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);

    if (!urlMatch || !titleMatch) continue;

    let href = urlMatch[1];
    // DuckDuckGo wraps URLs through their redirect — extract the actual URL
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      href = decodeURIComponent(uddgMatch[1]);
    }

    const title = stripHtml(titleMatch[1]).trim();
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : "";

    if (title && href) {
      results.push({ title, url: href, snippet });
    }
  }

  return results;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ");
}
