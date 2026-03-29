/**
 * Memory-aware effort auto-tuning.
 *
 * If phren has findings about the exact topic/file the user is asking about,
 * the agent already has context — lower effort is fine.
 * If it's novel territory with no prior findings, bump effort up.
 */
import type { PhrenContext } from "./context.js";
import type { EffortLevel } from "../providers/types.js";

interface TuningResult {
  /** Recommended effort level. */
  effort: EffortLevel;
  /** Reason for the recommendation. */
  reason: string;
  /** Whether this was auto-adjusted from the default. */
  adjusted: boolean;
}

/**
 * Analyze the task against phren's knowledge and recommend an effort level.
 * Returns the current effort if no adjustment is warranted.
 */
export async function tuneEffort(
  task: string,
  currentEffort: EffortLevel,
  ctx: PhrenContext,
): Promise<TuningResult> {
  // Don't auto-tune if user explicitly set effort to low or max
  if (currentEffort === "low" || currentEffort === "max") {
    return { effort: currentEffort, reason: "User-specified effort level", adjusted: false };
  }

  try {
    const { buildIndex } = await import("@phren/cli/shared");
    const { searchKnowledgeRows } = await import("@phren/cli/shared/retrieval");

    // Extract keywords from the task
    const keywords = extractTaskKeywords(task);
    if (keywords.length === 0) {
      return { effort: currentEffort, reason: "No keywords extracted", adjusted: false };
    }

    // Search phren for prior knowledge
    const db = await buildIndex(ctx.phrenPath, ctx.profile);
    const result = await searchKnowledgeRows(db, {
      query: keywords.join(" "),
      maxResults: 5,
      filterProject: ctx.project || null,
      filterType: null,
      phrenPath: ctx.phrenPath,
    });

    const hitCount = result.rows?.length ?? 0;

    // High knowledge coverage → can use less effort
    if (hitCount >= 4) {
      const newEffort = currentEffort === "high" ? "medium" : currentEffort;
      if (newEffort !== currentEffort) {
        return {
          effort: newEffort,
          reason: `${hitCount} relevant findings found — reducing effort (prior knowledge available)`,
          adjusted: true,
        };
      }
    }

    // No knowledge at all → bump up effort
    if (hitCount === 0 && currentEffort === "medium") {
      return {
        effort: "high",
        reason: "No prior findings for this topic — increasing effort (novel territory)",
        adjusted: true,
      };
    }

    return { effort: currentEffort, reason: `${hitCount} findings found`, adjusted: false };
  } catch {
    return { effort: currentEffort, reason: "Auto-tuning failed (best effort)", adjusted: false };
  }
}

/**
 * Extract meaningful keywords from a task description.
 * Filters out common words and keeps technical terms.
 */
function extractTaskKeywords(task: string): string[] {
  const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "must", "need",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us",
    "my", "your", "his", "its", "our", "their",
    "this", "that", "these", "those", "what", "which", "who", "whom",
    "and", "but", "or", "not", "no", "if", "then", "else", "when",
    "at", "by", "for", "with", "about", "against", "between", "through",
    "to", "from", "in", "on", "of", "up", "out", "off", "over", "under",
    "into", "onto", "upon",
    "please", "fix", "add", "make", "create", "update", "change", "modify",
    "help", "want", "like", "just", "also", "how", "why",
  ]);

  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9_\-.\/]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate and take top 6
  return [...new Set(words)].slice(0, 6);
}
