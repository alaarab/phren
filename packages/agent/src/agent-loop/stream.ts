import type { ToolUseBlock, StreamDelta, ContentBlock } from "../providers/types.js";
import type { CostTracker } from "../cost.js";
import type { PhrenContext } from "../memory/context.js";
import type { CaptureState } from "../memory/auto-capture.js";
import { ToolRegistry } from "../tools/registry.js";
import { searchErrorRecovery } from "../memory/error-recovery.js";
import { analyzeAndCapture } from "../memory/auto-capture.js";
import { AntiPatternTracker } from "../memory/anti-patterns.js";
import type { TurnHooks } from "./types.js";

const MAX_TOOL_CONCURRENCY = 5;

/** Run tool blocks with concurrency limit. Tracks execution duration per tool. */
export async function runToolsConcurrently(
  blocks: ToolUseBlock[],
  registry: ToolRegistry,
): Promise<Array<{ block: ToolUseBlock; output: string; is_error: boolean; durationMs: number }>> {
  const results: Array<{ block: ToolUseBlock; output: string; is_error: boolean; durationMs: number }> = [];
  for (let i = 0; i < blocks.length; i += MAX_TOOL_CONCURRENCY) {
    const batch = blocks.slice(i, i + MAX_TOOL_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (block) => {
        const TOOL_TIMEOUT_MS = 120_000;
        const start = Date.now();
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            registry.execute(block.name, block.input),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Tool '${block.name}' timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS);
            }),
          ]);
          clearTimeout(timer);
          return { block, output: result.output, is_error: !!result.is_error, durationMs: Date.now() - start };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { block, output: msg, is_error: true, durationMs: Date.now() - start };
        }
      }),
    );
    results.push(...batchResults);
  }
  return results;
}

/** Consume a chatStream into ContentBlock[] + stop_reason, streaming text via callback. */
export async function consumeStream(
  stream: AsyncIterable<StreamDelta>,
  costTracker?: CostTracker | null,
  onTextDelta?: (text: string) => void,
): Promise<{ content: ContentBlock[]; stop_reason: "end_turn" | "tool_use" | "max_tokens" }> {
  const content: ContentBlock[] = [];
  let stop_reason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
  let currentText = "";

  // Map block index -> tool state for Anthropic-style index-based IDs
  const toolsByIndex = new Map<string, { id: string; name: string; jsonParts: string[] }>();

  for await (const delta of stream) {
    if (delta.type === "text_delta") {
      (onTextDelta ?? process.stdout.write.bind(process.stdout))(delta.text);
      currentText += delta.text;
    } else if (delta.type === "tool_use_start") {
      // Flush accumulated text
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

  // Flush remaining text
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
}

/** Execute tool blocks, collect results with error recovery and anti-pattern tracking. */
export async function executeToolBlocks(
  toolUseBlocks: ToolUseBlock[],
  ctx: ToolExecContext,
): Promise<{ results: ContentBlock[]; toolCallCount: number }> {
  const execResults = await runToolsConcurrently(toolUseBlocks, ctx.registry);
  const results: ContentBlock[] = [];
  let toolCallCount = 0;

  for (const { block, output, is_error, durationMs } of execResults) {
    toolCallCount++;
    let finalOutput = output;

    ctx.antiPatterns.recordAttempt(block.name, block.input, !is_error, output);

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
      content: finalOutput,
      is_error,
    });
  }

  return { results, toolCallCount };
}
