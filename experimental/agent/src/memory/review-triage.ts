/**
 * Review-queue triage: the loop that keeps phren's governance practical.
 *
 * High-confidence knowledge never enters the queue (compaction promotes it
 * directly), so what does land here is genuinely uncertain. These helpers
 * surface the queue at session start, expire stale entries, and let the model
 * propose verdicts a human confirms — so triage happens inside the normal
 * workflow instead of piling up forever.
 */
import type { PhrenContext } from "./context.js";
import type { LlmMessage, LlmProvider } from "../providers/types.js";
import { readReviewQueue, rejectQueueItem, type QueueItem } from "@phren/cli/data/access";

export interface QueueStatusItem {
  text: string;
  /** Exact review.md line — approve/reject round-trip this verbatim. */
  line: string;
  date: string;
  ageDays: number | null;
}

export interface QueueStatus {
  pending: number;
  top: QueueStatusItem[];
}

const MS_PER_DAY = 86_400_000;

function ageDays(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((Date.now() - parsed) / MS_PER_DAY);
}

function toStatusItem(item: QueueItem): QueueStatusItem {
  return { text: item.text, line: item.line, date: item.date, ageDays: ageDays(item.date) };
}

/** Pending review items for the project. Never throws — empty on any failure. */
export function getQueueStatus(ctx: PhrenContext, topN = 3): QueueStatus {
  if (!ctx.project) return { pending: 0, top: [] };
  try {
    const result = readReviewQueue(ctx.phrenPath, ctx.project);
    if (!result.ok || !result.data) return { pending: 0, top: [] };
    const review = result.data.filter((item) => item.section === "Review");
    return { pending: review.length, top: review.slice(0, topN).map(toStatusItem) };
  } catch {
    return { pending: 0, top: [] };
  }
}

/** All pending review items (for /review). Never throws. */
export function listQueueItems(ctx: PhrenContext): QueueStatusItem[] {
  if (!ctx.project) return [];
  try {
    const result = readReviewQueue(ctx.phrenPath, ctx.project);
    if (!result.ok || !result.data) return [];
    return result.data.filter((item) => item.section === "Review").map(toStatusItem);
  } catch {
    return [];
  }
}

export const DEFAULT_EXPIRE_DAYS = 14;

/** Resolve the expiry window: PHREN_AGENT_QUEUE_EXPIRE_DAYS, 0 = never. */
export function resolveExpireDays(): number {
  const env = Number.parseInt(process.env.PHREN_AGENT_QUEUE_EXPIRE_DAYS ?? "", 10);
  if (Number.isFinite(env) && env >= 0) return env;
  return DEFAULT_EXPIRE_DAYS;
}

/**
 * Auto-reject review items older than expireDays. Undated items never expire.
 * Re-reads the queue so every rejected line round-trips exactly. Never throws.
 */
export function expireStaleItems(ctx: PhrenContext, expireDays: number): { expired: number } {
  if (!ctx.project || expireDays <= 0) return { expired: 0 };
  let expired = 0;
  try {
    for (const item of listQueueItems(ctx)) {
      if (item.ageDays === null || item.ageDays <= expireDays) continue;
      const result = rejectQueueItem(ctx.phrenPath, ctx.project, item.line);
      if (result.ok) expired++;
    }
  } catch {
    // best effort — whatever expired, expired
  }
  return { expired };
}

/** One-line session-start banner; null when the queue is empty. */
export function formatQueueBanner(status: QueueStatus): string | null {
  if (status.pending === 0) return null;
  const top = status.top
    .map((item) => `"${item.text.length > 60 ? `${item.text.slice(0, 60)}…` : item.text}"`)
    .join(", ");
  return `Review queue: ${status.pending} pending${top ? ` — ${top}` : ""} — /review to triage`;
}

/** Warm-start section: the model may know candidates exist, clearly unverified. */
export function formatQueueContextSection(status: QueueStatus): string | null {
  if (status.pending === 0) return null;
  const lines = status.top.map((item) => `- [unverified] ${item.text}`);
  return `## Review queue (${status.pending} pending — candidate knowledge nobody approved; do NOT treat as truth)\n\n${lines.join("\n")}`;
}

// ── Agent-assisted triage ────────────────────────────────────────────────────

export interface TriageProposal {
  index: number;
  text: string;
  line: string;
  verdict: "approve" | "reject";
  reason: string;
}

const TRIAGE_PROMPT_HEADER = `You are triaging a knowledge review queue for a software project. Each item is a candidate finding an agent extracted but was not confident enough to save directly. For each item decide:
- approve: durable, plausible, useful project knowledge
- reject: vague, speculative, obsolete, duplicated, or trivially obvious

Respond with ONLY a fenced json block:
\`\`\`json
{"proposals":[{"index":1,"verdict":"approve","reason":"one short sentence"}]}
\`\`\`

Items:`;

/**
 * One out-of-band LLM call proposing a verdict per item. Empty on any failure
 * (parse errors included) — the manual /review go path always still works.
 */
export async function proposeTriage(
  provider: LlmProvider,
  items: QueueStatusItem[],
): Promise<TriageProposal[]> {
  if (items.length === 0) return [];
  try {
    const numbered = items.map((item, i) => `${i + 1}. ${item.text}`).join("\n");
    const messages: LlmMessage[] = [
      { role: "user", content: `${TRIAGE_PROMPT_HEADER}\n${numbered}` },
    ];
    const response = await provider.chat("You are a precise knowledge-base curator.", messages, []);
    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
    const raw = fenced ? fenced[1] : text.match(/\{[\s\S]*"proposals"[\s\S]*\}/)?.[0];
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const proposals = (parsed as { proposals?: unknown }).proposals;
    if (!Array.isArray(proposals)) return [];

    const valid: TriageProposal[] = [];
    for (const p of proposals) {
      if (typeof p !== "object" || p === null) continue;
      const index = (p as { index?: unknown }).index;
      const verdict = (p as { verdict?: unknown }).verdict;
      const reason = (p as { reason?: unknown }).reason;
      if (typeof index !== "number" || index < 1 || index > items.length) continue;
      if (verdict !== "approve" && verdict !== "reject") continue;
      const item = items[index - 1];
      valid.push({
        index,
        text: item.text,
        line: item.line,
        verdict,
        reason: typeof reason === "string" ? reason : "",
      });
    }
    return valid;
  } catch {
    return [];
  }
}
