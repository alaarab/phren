import { createHash } from "crypto";
import { entryScoreKey } from "./governance/scores.js";
import { FINDINGS_FILENAME } from "./data/access.js";

// Bullet-finding patterns — must stay in lockstep with the graph builder
// (ui/data.ts) so computed node ids match the rendered finding nodes.
const TAGGED_BULLET = /^-\s+\[([a-z_-]+)\]\s+(.+?)(?:\s*<!--.*-->)?$/;
const PLAIN_BULLET = /^-\s+(.+?)(?:\s*<!--.*-->)?$/;
const MIN_PLAIN_LENGTH = 10;

/** Graph node id for a finding, derived from its score key (mirrors data.ts stableId("finding", …)). */
export function findingStableId(scoreKey: string): string {
  return `finding:${createHash("sha1").update(scoreKey).digest("hex").slice(0, 12)}`;
}

/**
 * Graph node id for a single FINDINGS.md bullet line, or null if the line is
 * not a node-bearing finding. Covers tagged (`- [tag] text`) and plain
 * (`- text`) bullets; heading-based findings are intentionally not matched
 * here (they need multi-line context and are rare).
 */
export function findingNodeIdForLine(project: string, line: string): string | null {
  const tagMatch = line.match(TAGGED_BULLET);
  if (tagMatch) {
    const tag = tagMatch[1];
    const text = tagMatch[2].trim();
    return findingStableId(entryScoreKey(project, FINDINGS_FILENAME, `[${tag}] ${text}`));
  }
  const plainMatch = line.match(PLAIN_BULLET);
  if (plainMatch) {
    const text = plainMatch[1].trim();
    if (text.length < MIN_PLAIN_LENGTH) return null;
    return findingStableId(entryScoreKey(project, FINDINGS_FILENAME, text));
  }
  return null;
}

/**
 * Pick the graph node id of the finding bullet in `content` that best matches
 * `query` (by query-term overlap). Returns null when no bullet shares a query
 * term, so callers can fall back to the project node.
 */
export function bestFindingNodeId(project: string, content: string, query: string): string | null {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (terms.length === 0) return null;
  let best: { id: string; score: number } | null = null;
  for (const line of content.split("\n")) {
    const id = findingNodeIdForLine(project, line);
    if (!id) continue;
    const lower = line.toLowerCase();
    let score = 0;
    for (const t of terms) if (lower.includes(t)) score++;
    if (score > 0 && (!best || score > best.score)) best = { id, score };
  }
  return best ? best.id : null;
}
