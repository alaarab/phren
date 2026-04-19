import { createSpinner, formatTurnHeader, formatToolCall } from "../spinner.js";
import { shouldPrune, pruneMessages } from "../context/pruner.js";
import { estimateMessageTokens } from "../context/token-counter.js";
import { withRetry } from "../providers/retry.js";
import { checkFlushNeeded } from "../memory/context-flush.js";
import { injectPlanPrompt, requestPlanApproval } from "../plan.js";
import { detectLintCommand, detectTestCommand, runPostEditCheck } from "../tools/lint-test.js";
import { createCheckpoint } from "../checkpoint.js";
import { createSession } from "./types.js";
import { consumeStream, executeToolBlocks } from "./stream.js";
export { createSession };
export async function runTurn(userInput, session, config, hooks) {
    const { provider, registry, maxTurns, verbose, costTracker } = config;
    let systemPrompt = config.systemPrompt;
    const toolDefs = registry.getDefinitions();
    const spinner = createSpinner();
    const useStream = typeof provider.chatStream === "function";
    const status = hooks?.onStatus ?? ((msg) => process.stderr.write(msg));
    // Plan mode: inject plan-first prompt and strip tools so the LLM
    // describes its plan before executing anything.  Works on any turn,
    // not just the first, so mid-session plan mode toggles also apply.
    let planPending = !!config.plan;
    if (planPending) {
        systemPrompt = injectPlanPrompt(systemPrompt);
    }
    // Append user message
    session.messages.push({ role: "user", content: userInput });
    let turnToolCalls = 0;
    const turnStart = session.turns;
    const signal = hooks?.signal;
    while (session.turns - turnStart < maxTurns) {
        // Abort check
        if (signal?.aborted)
            break;
        // Budget check
        if (costTracker?.isOverBudget()) {
            status(`\x1b[33m[budget exceeded: ${costTracker.formatCost()}]\x1b[0m\n`);
            break;
        }
        if (verbose && session.turns > turnStart) {
            status(`\n${formatTurnHeader(session.turns + 1, turnToolCalls)}\n`);
        }
        // Check if context flush is needed (one-time per session) — must run before pruning
        const contextLimit = provider.contextWindow ?? 200_000;
        const flushPrompt = checkFlushNeeded(systemPrompt, session.messages, session.flushConfig);
        if (flushPrompt) {
            session.messages.push({ role: "user", content: flushPrompt });
            if (verbose)
                status("[context flush injected]\n");
        }
        // Prune context if approaching limit
        if (shouldPrune(systemPrompt, session.messages, { contextLimit })) {
            const preCount = session.messages.length;
            const preTokens = estimateMessageTokens(session.messages);
            session.messages = pruneMessages(session.messages, { contextLimit, keepRecentTurns: 6 });
            const postCount = session.messages.length;
            const postTokens = estimateMessageTokens(session.messages);
            const reduction = preTokens > 0 ? ((1 - postTokens / preTokens) * 100).toFixed(0) : "0";
            const fmtPre = preTokens >= 1000 ? `${(preTokens / 1000).toFixed(1)}k` : String(preTokens);
            const fmtPost = postTokens >= 1000 ? `${(postTokens / 1000).toFixed(1)}k` : String(postTokens);
            status(`\x1b[2m[context pruned: ${preCount} → ${postCount} messages, ~${fmtPre} → ~${fmtPost} tokens, ${reduction}% reduction]\x1b[0m\n`);
        }
        // For plan mode first turn, pass empty tools so LLM can't call any
        const turnTools = planPending ? [] : toolDefs;
        let assistantContent;
        let stopReason;
        if (useStream) {
            // Streaming path — retry the initial connection (before consuming deltas)
            const stream = await withRetry(async () => provider.chatStream(systemPrompt, session.messages, turnTools), undefined, verbose);
            const result = await consumeStream(stream, costTracker, hooks?.onTextDelta, signal);
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
                    if (hooks?.onTextBlock) {
                        hooks.onTextBlock(block.text);
                    }
                    else {
                        process.stdout.write(block.text);
                        if (!block.text.endsWith("\n"))
                            process.stdout.write("\n");
                    }
                }
            }
        }
        session.messages.push({ role: "assistant", content: assistantContent });
        session.turns++;
        // Abort check after LLM response
        if (signal?.aborted)
            break;
        // Show turn cost
        if (verbose && costTracker) {
            status(`\x1b[2m  cost: ${costTracker.formatCost()}\x1b[0m\n`);
        }
        // Plan mode gate: after first response, ask for approval
        if (planPending) {
            planPending = false;
            const approve = hooks?.onPlanApproval ?? requestPlanApproval;
            const { approved, feedback } = await approve();
            if (!approved) {
                // Always restore original system prompt on rejection to prevent plan prompt leaking
                systemPrompt = config.systemPrompt;
                const msg = feedback
                    ? `The user rejected the plan with feedback: ${feedback}\nPlease revise your plan.`
                    : "The user rejected the plan. Task aborted.";
                if (feedback) {
                    // Let the LLM revise — add feedback as user message and continue
                    session.messages.push({ role: "user", content: msg });
                    continue;
                }
                break;
            }
            // Approved — restore original system prompt and continue with tools enabled
            systemPrompt = config.systemPrompt;
            session.messages.push({ role: "user", content: "Plan approved. Proceed with execution." });
            continue;
        }
        // If max_tokens, warn user and inject continuation prompt
        if (stopReason === "max_tokens") {
            status("\x1b[33m[response truncated: max_tokens reached, requesting continuation]\x1b[0m\n");
            session.messages.push({ role: "user", content: "Your response was truncated due to length. Please continue where you left off." });
            continue;
        }
        // If no tool use, we're done
        if (stopReason !== "tool_use")
            break;
        // Execute tool calls with concurrency
        const toolUseBlocks = assistantContent.filter((b) => b.type === "tool_use");
        // Log all tool calls upfront
        if (hooks?.onToolStart) {
            for (const block of toolUseBlocks)
                hooks.onToolStart(block.name, block.input, toolUseBlocks.length);
        }
        else {
            for (const block of toolUseBlocks)
                status(formatToolCall(block.name, block.input) + "\n");
        }
        if (!hooks?.onToolStart)
            spinner.start(`Running ${toolUseBlocks.length} tool${toolUseBlocks.length > 1 ? "s" : ""}...`);
        const { results: toolResults, toolCallCount } = await executeToolBlocks(toolUseBlocks, {
            registry, verbose, status, hooks,
            antiPatterns: session.antiPatterns,
            captureState: session.captureState,
            phrenCtx: config.phrenCtx,
        });
        if (!hooks?.onToolStart)
            spinner.stop();
        session.toolCalls += toolCallCount;
        turnToolCalls += toolCallCount;
        // Post-edit lint/test check
        const mutatingTools = new Set(["edit_file", "write_file"]);
        const hasMutation = toolUseBlocks.some(b => mutatingTools.has(b.name));
        if (hasMutation && config.lintTestConfig) {
            const cwd = process.cwd();
            const lintCmd = config.lintTestConfig.lintCmd ?? detectLintCommand(cwd);
            const testCmd = config.lintTestConfig.testCmd ?? detectTestCommand(cwd);
            const lintFailures = [];
            for (const cmd of [lintCmd, testCmd].filter(Boolean)) {
                const check = runPostEditCheck(cmd, cwd);
                if (!check.passed) {
                    if (verbose)
                        status(`\x1b[33m[post-edit check failed: ${cmd}]\x1b[0m\n`);
                    lintFailures.push(`Post-edit check failed (${cmd}):\n${check.output.slice(0, 2000)}`);
                }
            }
            if (lintFailures.length > 0) {
                // Inject as plain text in the tool results user message (not as a fabricated tool_result)
                toolResults.push({
                    type: "text",
                    text: lintFailures.join("\n\n"),
                });
            }
        }
        // Create checkpoint before mutating tool results are committed to conversation
        if (hasMutation) {
            createCheckpoint(process.cwd(), `turn-${session.turns}`);
        }
        // Add tool results as a user message
        session.messages.push({ role: "user", content: toolResults });
        // Steering input injection (TUI mid-turn input)
        const steer = hooks?.getSteeringInput?.();
        if (steer) {
            session.messages.push({ role: "user", content: steer });
        }
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
export async function runAgent(task, config) {
    const contextLimit = config.provider.contextWindow ?? 200_000;
    const session = createSession(contextLimit);
    const result = await runTurn(task, session, config, config.hooks);
    return {
        finalText: result.text,
        turns: result.turns,
        toolCalls: result.toolCalls,
        totalCost: config.costTracker?.formatCost(),
        messages: session.messages,
    };
}
