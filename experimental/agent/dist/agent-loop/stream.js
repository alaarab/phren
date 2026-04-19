import { searchErrorRecovery } from "../memory/error-recovery.js";
import { analyzeAndCapture } from "../memory/auto-capture.js";
const MAX_TOOL_CONCURRENCY = 5;
/** Run tool blocks with concurrency limit. Tracks execution duration per tool. */
export async function runToolsConcurrently(blocks, registry) {
    const results = [];
    for (let i = 0; i < blocks.length; i += MAX_TOOL_CONCURRENCY) {
        const batch = blocks.slice(i, i + MAX_TOOL_CONCURRENCY);
        const batchResults = await Promise.all(batch.map(async (block) => {
            const TOOL_TIMEOUT_MS = 120_000;
            const start = Date.now();
            try {
                let timer;
                const result = await Promise.race([
                    registry.execute(block.name, block.input),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error(`Tool '${block.name}' timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS);
                    }),
                ]);
                clearTimeout(timer);
                return { block, output: result.output, is_error: !!result.is_error, durationMs: Date.now() - start };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { block, output: msg, is_error: true, durationMs: Date.now() - start };
            }
        }));
        results.push(...batchResults);
    }
    return results;
}
/** Consume a chatStream into ContentBlock[] + stop_reason, streaming text via callback. */
export async function consumeStream(stream, costTracker, onTextDelta, signal) {
    const content = [];
    let stop_reason = "end_turn";
    let currentText = "";
    // Map block index -> tool state for Anthropic-style index-based IDs
    const toolsByIndex = new Map();
    for await (const delta of stream) {
        if (signal?.aborted)
            break;
        if (delta.type === "text_delta") {
            (onTextDelta ?? process.stdout.write.bind(process.stdout))(delta.text);
            currentText += delta.text;
        }
        else if (delta.type === "tool_use_start") {
            // Flush accumulated text
            if (currentText) {
                content.push({ type: "text", text: currentText });
                currentText = "";
            }
            toolsByIndex.set(delta.id, { id: delta.id, name: delta.name, jsonParts: [] });
        }
        else if (delta.type === "tool_use_delta") {
            const tool = toolsByIndex.get(delta.id);
            if (tool)
                tool.jsonParts.push(delta.json);
        }
        else if (delta.type === "tool_use_end") {
            const tool = toolsByIndex.get(delta.id);
            if (tool) {
                const jsonStr = tool.jsonParts.join("");
                let input = {};
                try {
                    input = JSON.parse(jsonStr);
                }
                catch {
                    process.stderr.write(`\x1b[33m[warning] Malformed tool_use JSON for ${tool.name} (${tool.id}), skipping block\x1b[0m\n`);
                    continue;
                }
                content.push({ type: "tool_use", id: tool.id, name: tool.name, input });
            }
        }
        else if (delta.type === "done") {
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
/** Execute tool blocks, collect results with error recovery and anti-pattern tracking. */
export async function executeToolBlocks(toolUseBlocks, ctx) {
    const execResults = await runToolsConcurrently(toolUseBlocks, ctx.registry);
    const results = [];
    let toolCallCount = 0;
    for (const { block, output, is_error, durationMs } of execResults) {
        toolCallCount++;
        let finalOutput = output;
        ctx.antiPatterns.recordAttempt(block.name, block.input, !is_error, output);
        if (is_error && ctx.phrenCtx) {
            try {
                const recovery = await searchErrorRecovery(ctx.phrenCtx, output);
                if (recovery)
                    finalOutput += recovery;
            }
            catch { /* best effort */ }
            try {
                await analyzeAndCapture(ctx.phrenCtx, output, ctx.captureState);
            }
            catch { /* best effort */ }
        }
        if (ctx.hooks?.onToolEnd) {
            ctx.hooks.onToolEnd(block.name, block.input, finalOutput, is_error, durationMs);
        }
        else if (ctx.verbose) {
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
