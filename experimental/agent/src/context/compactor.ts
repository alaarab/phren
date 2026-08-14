/**
 * LLM compaction with knowledge promotion.
 *
 * Replaces the regex prune summary with a checkpoint written by the same
 * provider via prefix replay: the summarization request reuses the
 * conversation's own system prompt and message prefix byte-identical, so the
 * provider's KV cache covers everything except the final instruction. The same
 * response carries candidate knowledge items that get routed by confidence:
 * high-confidence items become findings immediately (with session provenance),
 * mid-confidence items enter the review queue, the rest are dropped.
 *
 * Failure ladder: any error — call fails, times out, JSON botched, summary
 * empty — degrades to the existing regex planPrune summary with identical
 * indices. This module never throws into the turn and never touches the
 * session log (the caller applies the resulting plan as a log/replace).
 */
import type { LlmMessage, LlmProvider } from "../providers/types.js";
import type { CostTracker } from "../cost.js";
import type { PhrenContext } from "../memory/context.js";
import { planPrune, type PrunePlan, type PruneConfig } from "./pruner.js";
import { estimateMessageTokens } from "../context/token-counter.js";
import { agentProvenance } from "../memory/provenance.js";

export interface CompactionConfig {
  /** Master switch. PHREN_AGENT_LLM_COMPACT=0 or --no-llm-compact disables. */
  enabled: boolean;
  /** Extract knowledge items (needs a phren project to route into). */
  extractKnowledge: boolean;
  /** Confidence at or above which items become findings immediately. */
  promoteThreshold: number;
  /** Confidence at or above which items enter the review queue (below: dropped). */
  queueThreshold: number;
  /** Skip the LLM call when the pruned range is smaller than this. */
  minPrunedTokens: number;
  /** Summarization call timeout. */
  timeoutMs: number;
  /** Cap on knowledge items routed per compaction. */
  maxItems: number;
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  enabled: true,
  extractKnowledge: true,
  promoteThreshold: 0.8,
  queueThreshold: 0.5,
  minPrunedTokens: 8_000,
  timeoutMs: 60_000,
  maxItems: 8,
};

export function resolveCompactionConfig(overrides?: Partial<CompactionConfig>): CompactionConfig {
  const cfg = { ...DEFAULT_COMPACTION, ...overrides };
  if (process.env.PHREN_AGENT_LLM_COMPACT === "0") cfg.enabled = false;
  const envThreshold = Number.parseFloat(process.env.PHREN_AGENT_COMPACT_THRESHOLD ?? "");
  if (Number.isFinite(envThreshold) && envThreshold > 0 && envThreshold <= 1) {
    cfg.promoteThreshold = envThreshold;
  }
  const envMin = Number.parseInt(process.env.PHREN_AGENT_COMPACT_MIN_TOKENS ?? "", 10);
  if (Number.isFinite(envMin) && envMin >= 0) cfg.minPrunedTokens = envMin;
  return cfg;
}

export interface KnowledgeItem {
  text: string;
  confidence: number;
  kind: string;
}

export interface CompactionResult {
  plan: PrunePlan;
  usedLlm: boolean;
  promoted: number;
  queued: number;
}

const CHECKPOINT_INSTRUCTION = `[Context checkpoint — this conversation is about to be compacted. Ignore any pending questions above and respond with ONLY the following two sections:]

## Checkpoint Summary
The original task; work completed so far; files created or modified; the current approach and why; unresolved errors or blockers; immediate next steps. Under 400 words, written for an agent resuming this work with no other history.

## Knowledge
A fenced json block: {"items":[{"text":"...","confidence":0.9,"kind":"finding|gotcha|decision"}]}
Only durable, non-obvious, project-level knowledge worth remembering across sessions (root causes, architecture decisions with rationale, gotchas, workarounds). Confidence is YOUR certainty the item is true and durable, 0 to 1. Use {"items":[]} if nothing qualifies. Never include secrets or credentials.`;

// ── Response parsing ─────────────────────────────────────────────────────────

const KNOWLEDGE_HEADING_RE = /^##\s*Knowledge\b.*$/im;
const SUMMARY_HEADING_RE = /^##\s*Checkpoint Summary\b.*$/im;
const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/;
const MIN_SUMMARY_CHARS = 50;

function parseItems(raw: string): KnowledgeItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const valid: KnowledgeItem[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const text = (item as { text?: unknown }).text;
    const confidence = (item as { confidence?: unknown }).confidence;
    const kind = (item as { kind?: unknown }).kind;
    if (typeof text !== "string" || !text.trim()) continue;
    const conf = typeof confidence === "number" && Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0;
    valid.push({ text: text.trim(), confidence: conf, kind: typeof kind === "string" ? kind : "finding" });
  }
  return valid;
}

/**
 * Parse the checkpoint response: summary text + knowledge items.
 * Botched JSON never discards the summary; a missing/short summary returns
 * null so the caller falls back to the regex summary.
 */
export function parseCheckpointResponse(text: string): { summary: string | null; items: KnowledgeItem[] } {
  const headingMatch = text.match(KNOWLEDGE_HEADING_RE);
  let summaryPart = text;
  let knowledgePart = "";
  if (headingMatch && headingMatch.index !== undefined) {
    summaryPart = text.slice(0, headingMatch.index);
    knowledgePart = text.slice(headingMatch.index + headingMatch[0].length);
  }

  // Strip the summary heading itself; keep the body.
  const summary = summaryPart.replace(SUMMARY_HEADING_RE, "").trim();

  let items: KnowledgeItem[] = [];
  if (knowledgePart) {
    const fenced = knowledgePart.match(FENCED_JSON_RE);
    if (fenced) {
      items = parseItems(fenced[1]);
    }
    if (items.length === 0) {
      // Salvage: bare JSON object containing "items" without a fence.
      const bare = knowledgePart.match(/\{[\s\S]*"items"[\s\S]*\}/);
      if (bare) items = parseItems(bare[0]);
    }
  }

  if (summary.length < MIN_SUMMARY_CHARS) {
    return { summary: null, items };
  }
  return { summary, items };
}

// ── Knowledge routing ────────────────────────────────────────────────────────

interface RouteOpts {
  phrenCtx: PhrenContext;
  sessionId?: string | null;
  config: CompactionConfig;
  verbose?: boolean;
}

/** Route knowledge items by confidence. Returns counts; never throws. */
export async function routeKnowledgeItems(
  items: KnowledgeItem[],
  opts: RouteOpts,
): Promise<{ promoted: number; queued: number }> {
  const { phrenCtx, sessionId, config } = opts;
  let promoted = 0;
  let queued = 0;
  if (!phrenCtx.project || items.length === 0) return { promoted, queued };

  const capped = items.slice(0, config.maxItems);
  const toQueue: KnowledgeItem[] = [];

  for (const item of capped) {
    if (item.confidence >= config.promoteThreshold) {
      try {
        const { addFindingToFile } = await import("@phren/cli/shared/content");
        const result = addFindingToFile(phrenCtx.phrenPath, phrenCtx.project, item.text, undefined, {
          provenance: agentProvenance(sessionId),
          ...(sessionId ? { sessionId } : {}),
        });
        if (result.ok) promoted++;
      } catch { /* best effort */ }
    } else if (item.confidence >= config.queueThreshold) {
      toQueue.push(item);
    }
    // below queueThreshold: dropped
  }

  if (toQueue.length > 0) {
    try {
      const { appendReviewQueue } = await import("@phren/cli/shared/governance");
      const { buildQueueProvenanceMeta } = await import("@phren/cli/cli/extract");
      const meta = buildQueueProvenanceMeta({
        source: "agent",
        ...(sessionId ? { sessionId } : {}),
      });
      const result = appendReviewQueue(
        phrenCtx.phrenPath,
        phrenCtx.project,
        "Review",
        toQueue.map((item) => ({ text: item.text, meta })),
      );
      if (result.ok) queued = result.data ?? toQueue.length;
    } catch { /* best effort */ }
  }

  return { promoted, queued };
}

// ── Compaction ───────────────────────────────────────────────────────────────

export interface CompactOpts {
  phrenCtx?: PhrenContext | null;
  sessionId?: string | null;
  costTracker?: CostTracker | null;
  config?: Partial<CompactionConfig>;
  pruneConfig?: Partial<PruneConfig>;
  signal?: AbortSignal;
  verbose?: boolean;
}

/**
 * Plan a compaction: decide the prune range via planPrune, then try to upgrade
 * the summary via an out-of-band prefix-replay call to the same provider,
 * routing extracted knowledge into phren. Falls back to the regex summary on
 * any failure. Returns null when there is nothing to prune. Never throws.
 *
 * The provider call goes through provider.chat directly (never runTurn), so it
 * cannot recurse into pruning or touch the session log.
 */
export async function compactWithLlm(
  provider: LlmProvider,
  systemPrompt: string,
  messages: LlmMessage[],
  opts: CompactOpts = {},
): Promise<CompactionResult | null> {
  const config = resolveCompactionConfig(opts.config);
  const plan = planPrune(messages, opts.pruneConfig);
  if (!plan) return null;

  const regexResult: CompactionResult = { plan, usedLlm: false, promoted: 0, queued: 0 };
  if (!config.enabled || opts.signal?.aborted) return regexResult;

  const prunedRange = messages.slice(plan.startIndex, plan.endIndex + 1);
  if (estimateMessageTokens(prunedRange) < config.minPrunedTokens) return regexResult;

  let responseText: string;
  try {
    // Prefix replay: byte-identical system prompt + message prefix up to the
    // end of the pruned range, then one instruction. The provider's KV cache
    // covers the prefix, so this costs roughly one summary generation.
    const prefixMessages: LlmMessage[] = [
      ...messages.slice(0, plan.endIndex + 1),
      { role: "user", content: CHECKPOINT_INSTRUCTION },
    ];
    const response = await withTimeout(
      provider.chat(systemPrompt, prefixMessages, []),
      config.timeoutMs,
      opts.signal,
    );
    if (response.usage && opts.costTracker) {
      opts.costTracker.recordUsage(response.usage.input_tokens, response.usage.output_tokens);
    }
    responseText = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  } catch {
    return regexResult;
  }

  const { summary, items } = parseCheckpointResponse(responseText);

  let promoted = 0;
  let queued = 0;
  if (config.extractKnowledge && opts.phrenCtx?.project && items.length > 0) {
    const routed = await routeKnowledgeItems(items, {
      phrenCtx: opts.phrenCtx,
      sessionId: opts.sessionId,
      config,
      verbose: opts.verbose,
    });
    promoted = routed.promoted;
    queued = routed.queued;
  }

  if (!summary) {
    // Knowledge may still have routed; the summary falls back to regex.
    return { ...regexResult, promoted, queued };
  }

  const prunedCount = plan.endIndex - plan.startIndex + 1;
  const summaryMessage: LlmMessage = {
    role: "user",
    content: `[Context compacted: ${prunedCount} messages summarized]\n\n${summary}`,
  };
  return {
    plan: { ...plan, summaryMessage },
    usedLlm: true,
    promoted,
    queued,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`compaction call timed out after ${ms}ms`)), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("compaction aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(value); },
      (err) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}
