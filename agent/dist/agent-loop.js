import { createSpinner, formatTurnHeader, formatToolCall } from "./spinner.js";
import { searchErrorRecovery } from "./memory/error-recovery.js";
import { shouldPrune, pruneMessages } from "./context/pruner.js";
import { withRetry } from "./providers/retry.js";
import { createCaptureState, analyzeAndCapture } from "./memory/auto-capture.js";
import { AntiPatternTracker } from "./memory/anti-patterns.js";
import { createFlushConfig, checkFlushNeeded } from "./memory/context-flush.js";
import { injectPlanPrompt, requestPlanApproval } from "./plan.js";
import { detectLintCommand, detectTestCommand, runPostEditCheck } from "./tools/lint-test.js";
import { createCheckpoint } from "./checkpoint.js";
const MAX_TOOL_CONCURRENCY = 5;
const MAX_LINT_TEST_RETRIES = 3;
export function createSession(contextLimit) {
    return {
        messages: [],
        turns: 0,
        toolCalls: 0,
        captureState: createCaptureState(),
        antiPatterns: new AntiPatternTracker(),
        flushConfig: createFlushConfig(contextLimit ?? 200_000),
    };
}
/** Run tool blocks with concurrency limit. */
async function runToolsConcurrently(blocks, registry) {
    const results = [];
    for (let i = 0; i < blocks.length; i += MAX_TOOL_CONCURRENCY) {
        const batch = blocks.slice(i, i + MAX_TOOL_CONCURRENCY);
        const batchResults = await Promise.all(batch.map(async (block) => {
            const result = await registry.execute(block.name, block.input);
            return { block, output: result.output, is_error: !!result.is_error };
        }));
        results.push(...batchResults);
    }
    return results;
}
/** Consume a chatStream into ContentBlock[] + stop_reason, streaming text to stdout. */
async function consumeStream(stream, costTracker) {
    const content = [];
    let stop_reason = "end_turn";
    let currentText = "";
    // Map block index -> tool state for Anthropic-style index-based IDs
    const toolsByIndex = new Map();
    for await (const delta of stream) {
        if (delta.type === "text_delta") {
            process.stdout.write(delta.text);
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
                catch { /* malformed */ }
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
        if (!currentText.endsWith("\n"))
            process.stdout.write("\n");
        content.push({ type: "text", text: currentText });
    }
    return { content, stop_reason };
}
export async function runTurn(userInput, session, config) {
    const { provider, registry, maxTurns, verbose, costTracker } = config;
    let systemPrompt = config.systemPrompt;
    const toolDefs = registry.getDefinitions();
    const spinner = createSpinner();
    const useStream = typeof provider.chatStream === "function";
    // Plan mode: modify system prompt for first turn
    let planPending = config.plan && session.turns === 0;
    if (planPending) {
        systemPrompt = injectPlanPrompt(systemPrompt);
    }
    // Append user message
    session.messages.push({ role: "user", content: userInput });
    let turnToolCalls = 0;
    const turnStart = session.turns;
    while (session.turns - turnStart < maxTurns) {
        // Budget check
        if (costTracker?.isOverBudget()) {
            process.stderr.write(`\x1b[33m[budget exceeded: ${costTracker.formatCost()}]\x1b[0m\n`);
            break;
        }
        if (verbose && session.turns > turnStart) {
            process.stderr.write(`\n${formatTurnHeader(session.turns + 1, turnToolCalls)}\n`);
        }
        // Prune context if approaching limit
        const contextLimit = provider.contextWindow ?? 200_000;
        if (shouldPrune(systemPrompt, session.messages, { contextLimit })) {
            session.messages = pruneMessages(session.messages, { contextLimit, keepRecentTurns: 6 });
            if (verbose)
                process.stderr.write("[context pruned]\n");
        }
        // Check if context flush is needed (one-time per session)
        const flushPrompt = checkFlushNeeded(systemPrompt, session.messages, session.flushConfig);
        if (flushPrompt) {
            session.messages.push({ role: "user", content: flushPrompt });
            if (verbose)
                process.stderr.write("[context flush injected]\n");
        }
        // For plan mode first turn, pass empty tools so LLM can't call any
        const turnTools = planPending ? [] : toolDefs;
        let assistantContent;
        let stopReason;
        if (useStream) {
            // Streaming path
            const stream = provider.chatStream(systemPrompt, session.messages, turnTools);
            const result = await consumeStream(stream, costTracker);
            assistantContent = result.content;
            stopReason = result.stop_reason;
        }
        else {
            // Batch path
            spinner.start("Thinking...");
            const response = await withRetry(() => provider.chat(systemPrompt, session.messages, turnTools), undefined, verbose);
            spinner.stop();
            assistantContent = response.content;
            stopReason = response.stop_reason;
            // Track cost from batch response
            if (costTracker && response.usage) {
                costTracker.recordUsage(response.usage.input_tokens, response.usage.output_tokens);
            }
            // Print text blocks (streaming already prints inline)
            for (const block of assistantContent) {
                if (block.type === "text" && block.text) {
                    process.stdout.write(block.text);
                    if (!block.text.endsWith("\n"))
                        process.stdout.write("\n");
                }
            }
        }
        session.messages.push({ role: "assistant", content: assistantContent });
        session.turns++;
        // Show turn cost
        if (verbose && costTracker) {
            process.stderr.write(`\x1b[2m  cost: ${costTracker.formatCost()}\x1b[0m\n`);
        }
        // Plan mode gate: after first response, ask for approval
        if (planPending) {
            planPending = false;
            const { approved, feedback } = await requestPlanApproval();
            if (!approved) {
                const msg = feedback
                    ? `The user rejected the plan with feedback: ${feedback}\nPlease revise your plan.`
                    : "The user rejected the plan. Task aborted.";
                if (feedback) {
                    // Let the LLM revise — add feedback as user message and continue
                    session.messages.push({ role: "user", content: msg });
                    // Restore original system prompt (without plan suffix) for subsequent turns
                    systemPrompt = config.systemPrompt;
                    continue;
                }
                break;
            }
            // Approved — restore original system prompt and continue with tools enabled
            systemPrompt = config.systemPrompt;
            session.messages.push({ role: "user", content: "Plan approved. Proceed with execution." });
            continue;
        }
        // If no tool use, we're done
        if (stopReason !== "tool_use")
            break;
        // Execute tool calls with concurrency
        const toolUseBlocks = assistantContent.filter((b) => b.type === "tool_use");
        // Log all tool calls upfront
        for (const block of toolUseBlocks) {
            process.stderr.write(formatToolCall(block.name, block.input) + "\n");
        }
        spinner.start(`Running ${toolUseBlocks.length} tool${toolUseBlocks.length > 1 ? "s" : ""}...`);
        const execResults = await runToolsConcurrently(toolUseBlocks, registry);
        spinner.stop();
        const toolResults = [];
        for (const { block, output, is_error } of execResults) {
            session.toolCalls++;
            turnToolCalls++;
            let finalOutput = output;
            // Record for anti-pattern tracking
            session.antiPatterns.recordAttempt(block.name, block.input, !is_error, output);
            // Append phren recovery context on tool errors
            if (is_error && config.phrenCtx) {
                try {
                    const recovery = await searchErrorRecovery(config.phrenCtx, output);
                    if (recovery)
                        finalOutput += recovery;
                }
                catch { /* best effort */ }
                // Auto-capture error patterns
                try {
                    await analyzeAndCapture(config.phrenCtx, output, session.captureState);
                }
                catch { /* best effort */ }
            }
            if (verbose) {
                const preview = finalOutput.slice(0, 200);
                process.stderr.write(`\x1b[2m  ← ${is_error ? "ERROR: " : ""}${preview}${finalOutput.length > 200 ? "..." : ""}\x1b[0m\n`);
            }
            toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: finalOutput,
                is_error,
            });
        }
        // Post-edit lint/test check
        const mutatingTools = new Set(["edit_file", "write_file"]);
        const hasMutation = toolUseBlocks.some(b => mutatingTools.has(b.name));
        if (hasMutation && config.lintTestConfig) {
            const cwd = process.cwd();
            const lintCmd = config.lintTestConfig.lintCmd ?? detectLintCommand(cwd);
            const testCmd = config.lintTestConfig.testCmd ?? detectTestCommand(cwd);
            for (const cmd of [lintCmd, testCmd].filter(Boolean)) {
                const check = runPostEditCheck(cmd, cwd);
                if (!check.passed) {
                    if (verbose)
                        process.stderr.write(`\x1b[33m[post-edit check failed: ${cmd}]\x1b[0m\n`);
                    // Inject failure as a tool result so the LLM can fix it
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: `lint-test-${Date.now()}`,
                        content: `Post-edit check failed (${cmd}):\n${check.output.slice(0, 2000)}`,
                        is_error: true,
                    });
                }
            }
        }
        // Create checkpoint before mutating tool results are committed to conversation
        if (hasMutation) {
            createCheckpoint(process.cwd(), `turn-${session.turns}`);
        }
        // Add tool results as a user message
        session.messages.push({ role: "user", content: toolResults });
    }
    // Extract text from the last assistant message in this turn
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    let text = "";
    if (lastAssistant && Array.isArray(lastAssistant.content)) {
        text = lastAssistant.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    }
    else if (lastAssistant && typeof lastAssistant.content === "string") {
        text = lastAssistant.content;
    }
    return { text, turns: session.turns - turnStart, toolCalls: turnToolCalls };
}
/** One-shot agent run — thin wrapper around createSession + runTurn. */
export async function runAgent(task, config) {
    const contextLimit = config.provider.contextWindow ?? 200_000;
    const session = createSession(contextLimit);
    const result = await runTurn(task, session, config);
    return {
        finalText: result.text,
        turns: result.turns,
        toolCalls: result.toolCalls,
        totalCost: config.costTracker?.formatCost(),
        messages: session.messages,
    };
}
