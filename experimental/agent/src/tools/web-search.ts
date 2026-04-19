/**
 * Web search tool — search the web for documentation, error messages, APIs.
 *
 * Uses DuckDuckGo HTML search (no API key required) as the default backend.
 * Falls back gracefully if the search fails.
 */
import type { AgentTool } from "./types.js";

export function createWebSearchTool(): AgentTool {
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
    async execute(input) {
      const query = input.query as string;
      const limit = Math.min((input.limit as number) || 5, 10);

      try {
        const results = await searchDuckDuckGo(query, limit);
        if (results.length === 0) {
          return { output: "No search results found." };
        }

        const formatted = results.map((r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`
        ).join("\n\n");

        return { output: formatted };
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

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "phren-agent/0.1 (search tool)",
      "Accept": "text/html",
    },
    signal: AbortSignal.timeout(10_000),
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
