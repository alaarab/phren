import type { PhrenContext } from "./context.js";
import { buildIndex } from "../../shared/index.js";
import { searchKnowledgeRows, rankResults } from "../../shared/retrieval.js";

const NOISE_WORDS = new Set([
  "at", "in", "of", "the", "is", "was", "error", "err", "warning",
  "from", "to", "and", "or", "not", "with", "for", "on", "by",
  "null", "undefined", "true", "false", "function", "object",
]);

const HEX_PATTERN = /\b0x[0-9a-f]+\b/gi;
const STACK_LINE = /^\s+at\s+/;
const PATH_NOISE = /\(?\/?[\w./\\-]+:\d+:\d+\)?/g;

/** Extract meaningful keywords from an error string. */
function extractErrorKeywords(errorOutput: string): string {
  const lines = errorOutput.split("\n");
  // Keep only non-stack-trace lines
  const meaningful = lines
    .filter((l) => !STACK_LINE.test(l))
    .slice(0, 5)
    .join(" ");

  const cleaned = meaningful
    .replace(HEX_PATTERN, "")
    .replace(PATH_NOISE, "")
    .replace(/[^a-zA-Z0-9_\s.-]/g, " ");

  const words = cleaned
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NOISE_WORDS.has(w.toLowerCase()))
    .slice(0, 12);

  return words.join(" ");
}

/**
 * Search phren for past knowledge related to a tool error.
 * Returns a formatted context string, or empty string on no results / error.
 */
export async function searchErrorRecovery(ctx: PhrenContext, errorOutput: string): Promise<string> {
  try {
    const keywords = extractErrorKeywords(errorOutput);
    if (!keywords.trim()) return "";

    const db = await buildIndex(ctx.phrenPath, ctx.profile || undefined);
    const result = await searchKnowledgeRows(db, {
      query: keywords,
      maxResults: 6,
      filterProject: ctx.project || null,
      filterType: null,
      phrenPath: ctx.phrenPath,
    });
    const ranked = rankResults(result.rows ?? [], keywords, null, ctx.project || null, ctx.phrenPath, db);

    if (ranked.length === 0) return "";

    const snippets = ranked.slice(0, 3).map((r: { project: string; filename: string; content?: string }) => {
      const content = r.content?.slice(0, 300) ?? "";
      return `[${r.project}/${r.filename}] ${content}`;
    });

    return `\n\n--- phren recovery context ---\n${snippets.join("\n\n")}`;
  } catch {
    return "";
  }
}
