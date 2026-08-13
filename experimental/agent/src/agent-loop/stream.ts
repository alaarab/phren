import type { ToolUseBlock, StreamDelta, ContentBlock } from "../providers/types.js";
import type { AgentToolImage } from "../tools/types.js";
import { chainKey, recordCall, type RepeatChainState } from "../guards/repeat-tool-reminder.js";
import type { CostTracker } from "../cost.js";
import type { PhrenContext } from "../memory/context.js";
import type { CaptureState } from "../memory/auto-capture.js";
import { ToolRegistry } from "../tools/registry.js";
import { searchErrorRecovery } from "../memory/error-recovery.js";
import { analyzeAndCapture } from "../memory/auto-capture.js";
import { AntiPatternTracker } from "../memory/anti-patterns.js";
import type { TurnHooks } from "./types.js";

const MAX_TOOL_CONCURRENCY = 5;

/** Default per-call budget when the tool declares none. */
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

type ToolExecResult = { block: ToolUseBlock; output: string; is_error: boolean; durationMs: number; images?: AgentToolImage[] };

/**
 * Run tool blocks with concurrency limit. Tracks execution duration per tool.
 *
 * Identical calls (same tool, same canonicalized arguments) within one
 * assistant message execute once and share the result — the fixed windows
 * launch a whole batch at once, so post-hoc repeat detection alone cannot
 * stop N copies of the same call from all running.
 *
 * The per-call deadline comes from the tool's own timeoutMs declaration
 * (default 120s). Expiry aborts the call's signal AND settles the result;
 * a tool that ignores the signal keeps running detached.
 */
export async function runToolsConcurrently(
  blocks: ToolUseBlock[],
  registry: ToolRegistry,
): Promise<ToolExecResult[]> {
  // Dedupe identical calls within this message: first occurrence executes.
  const byKey = new Map<string, ToolUseBlock>();
  const duplicates = new Map<ToolUseBlock, ToolUseBlock>(); // dup -> canonical
  for (const block of blocks) {
    const key = chainKey(block.name, block.input);
    const first = byKey.get(key);
    if (first) duplicates.set(block, first);
    else byKey.set(key, block);
  }
  const uniques = blocks.filter((b) => !duplicates.has(b));

  const resultsByBlock = new Map<ToolUseBlock, ToolExecResult>();
  for (let i = 0; i < uniques.length; i += MAX_TOOL_CONCURRENCY) {
    const batch = uniques.slice(i, i + MAX_TOOL_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (block) => {
        const timeoutMs = registry.get(block.name)?.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
        const start = Date.now();
        const abort = new AbortController();
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            registry.execute(block.name, block.input, abort.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                abort.abort(new Error(`timeout after ${timeoutMs / 1000}s`));
                reject(new Error(`Tool '${block.name}' timed out after ${timeoutMs / 1000}s`));
              }, timeoutMs);
            }),
          ]);
          clearTimeout(timer);
          return {
            block,
            output: result.output,
            is_error: !!result.is_error,
            durationMs: Date.now() - start,
            ...(result.images && result.images.length > 0 ? { images: result.images } : {}),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { block, output: msg, is_error: true, durationMs: Date.now() - start };
        }
      }),
    );
    for (const r of batchResults) resultsByBlock.set(r.block, r);
  }

  // Model order preserved; duplicates share the canonical result with a note.
  return blocks.map((block) => {
    const canonical = duplicates.get(block);
    if (!canonical) return resultsByBlock.get(block)!;
    const shared = resultsByBlock.get(canonical)!;
    return {
      ...shared,
      block,
      output: `${shared.output}\n\n[duplicate call: identical to a call in this same message; the result above was computed once and shared]`,
    };
  });
}

export interface ConsumeStreamHooks {
  onTextDelta?: (text: string) => void;
  /** Streaming reasoning/thinking token. Never routed to stdout by default. */
  onReasoningDelta?: (text: string) => void;
  /**
   * Active provider name, stamped onto assembled reasoning blocks. Serializers
   * drop reasoning from other providers (and untagged blocks), so an unstamped
   * block would silently fail to round-trip.
   */
  providerName?: string;
}

/** Consume a chatStream into ContentBlock[] + stop_reason, streaming text via callback. */
export async function consumeStream(
  stream: AsyncIterable<StreamDelta>,
  costTracker?: CostTracker | null,
  hooks?: ConsumeStreamHooks | ((text: string) => void),
  signal?: AbortSignal,
): Promise<{ content: ContentBlock[]; stop_reason: "end_turn" | "tool_use" | "max_tokens" }> {
  const onTextDelta = typeof hooks === "function" ? hooks : hooks?.onTextDelta;
  const onReasoningDelta = typeof hooks === "function" ? undefined : hooks?.onReasoningDelta;
  const providerName = typeof hooks === "function" ? undefined : hooks?.providerName;
  const content: ContentBlock[] = [];
  let stop_reason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
  let currentText = "";
  let currentReasoning = "";

  // Map block index -> tool state for Anthropic-style index-based IDs
  const toolsByIndex = new Map<string, { id: string; name: string; jsonParts: string[] }>();

  // Reasoning must land BEFORE the text/tool blocks it preceded: Anthropic
  // requires thinking blocks first in the assistant content array.
  const flushReasoning = (end?: Extract<StreamDelta, { type: "reasoning_end" }>) => {
    if (!currentReasoning && !end?.redacted && !end?.encrypted_content) return;
    content.push({
      type: "reasoning",
      text: currentReasoning,
      ...(providerName !== undefined ? { provider: providerName } : {}),
      ...(end?.signature !== undefined ? { signature: end.signature } : {}),
      ...(end?.id !== undefined ? { id: end.id } : {}),
      ...(end?.encrypted_content !== undefined ? { encrypted_content: end.encrypted_content } : {}),
      ...(end?.redacted ? { redacted: true } : {}),
      ...(end?.data !== undefined ? { data: end.data } : {}),
    });
    currentReasoning = "";
  };

  for await (const delta of stream) {
    if (signal?.aborted) break;
    if (delta.type === "text_delta") {
      (onTextDelta ?? process.stdout.write.bind(process.stdout))(delta.text);
      currentText += delta.text;
    } else if (delta.type === "reasoning_delta") {
      // Preserve stream order: a reasoning segment starting after visible
      // text closes that text block first (providers normally emit
      // reasoning before text, so this is the uncommon direction).
      if (currentText && !currentReasoning) {
        content.push({ type: "text", text: currentText });
        currentText = "";
      }
      onReasoningDelta?.(delta.text);
      currentReasoning += delta.text;
    } else if (delta.type === "reasoning_end") {
      flushReasoning(delta);
    } else if (delta.type === "tool_use_start") {
      // Flush accumulated reasoning (without a reasoning_end, e.g. compat
      // providers that only emit deltas), then text.
      flushReasoning();
      if (currentText) {
        content.push({ type: "text", text: currentText });
        currentText = "";
      }
      toolsByIndex.set(delta.id, { id: delta.id, name: delta.name, jsonParts: [] });
    } else if (delta.type === "tool_use_delta") {
      const tool = toolsByIndex.get(delta.id);
      if (tool) tool.jsonParts.push(delta.json);
    } else if (delta.type === "tool_use_end") {
      const tool = toolsByIndex.get(delta.id);
      if (tool) {
        const jsonStr = tool.jsonParts.join("");
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(jsonStr);
        } catch {
          process.stderr.write(`\x1b[33m[warning] Malformed tool_use JSON for ${tool.name} (${tool.id}), skipping block\x1b[0m\n`);
          continue;
        }
        content.push({ type: "tool_use", id: tool.id, name: tool.name, input });
      }
    } else if (delta.type === "done") {
      stop_reason = delta.stop_reason;
      if (costTracker && delta.usage) {
        costTracker.recordUsage(delta.usage.input_tokens, delta.usage.output_tokens);
      }
    }
  }

  // Flush remaining reasoning, then text
  flushReasoning();
  if (currentText) {
    if (!currentText.endsWith("\n")) {
      (onTextDelta ?? process.stdout.write.bind(process.stdout))("\n");
    }
    content.push({ type: "text", text: currentText });
  }

  return { content, stop_reason };
}

export interface ToolExecContext {
  registry: ToolRegistry;
  antiPatterns: AntiPatternTracker;
  captureState: CaptureState;
  phrenCtx?: PhrenContext | null;
  verbose: boolean;
  hooks?: TurnHooks;
  status: (msg: string) => void;
  /** Repeat-call chain state (session-scoped); reminders append to results. */
  repeatChain?: RepeatChainState;
}

/** Execute tool blocks, collect results with error recovery and anti-pattern tracking. */
export async function executeToolBlocks(
  toolUseBlocks: ToolUseBlock[],
  ctx: ToolExecContext,
): Promise<{ results: ContentBlock[]; toolCallCount: number }> {
  const execResults = await runToolsConcurrently(toolUseBlocks, ctx.registry);
  const results: ContentBlock[] = [];
  let toolCallCount = 0;

  for (const { block, output, is_error, durationMs, images } of execResults) {
    toolCallCount++;
    let finalOutput = output;

    ctx.antiPatterns.recordAttempt(block.name, block.input, !is_error, output);

    // Repeat-call guard: counts every executed call (denied and failed calls
    // included — a model hammering a denied call is exactly the loop worth
    // breaking) and appends an escalating reminder at thresholds.
    if (ctx.repeatChain) {
      const reminder = recordCall(ctx.repeatChain, block.name, block.input);
      if (reminder) finalOutput += reminder;
    }

    if (is_error && ctx.phrenCtx) {
      try {
        const recovery = await searchErrorRecovery(ctx.phrenCtx, output);
        if (recovery) finalOutput += recovery;
      } catch { /* best effort */ }

      try {
        await analyzeAndCapture(ctx.phrenCtx, output, ctx.captureState);
      } catch { /* best effort */ }
    }

    if (ctx.hooks?.onToolEnd) {
      ctx.hooks.onToolEnd(block.name, block.input, finalOutput, is_error, durationMs);
    } else if (ctx.verbose) {
      const preview = finalOutput.slice(0, 200);
      ctx.status(`\x1b[2m  ← ${is_error ? "ERROR: " : ""}${preview}${finalOutput.length > 200 ? "..." : ""}\x1b[0m\n`);
    }

    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: images
        ? [
            { type: "text", text: finalOutput },
            ...images.map((img) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: img.media_type, data: img.data },
            })),
          ]
        : finalOutput,
      is_error,
    });
  }

  return { results, toolCallCount };
}
