import type { ContentBlock, ToolUseBlock } from "../providers/types.js";
import { createSpinner, formatTurnHeader, formatToolCall } from "../spinner.js";
import { shouldPrune } from "../context/pruner.js";
import { compactWithLlm } from "../context/compactor.js";
import { estimateMessageTokens } from "../context/token-counter.js";
import { isContextOverflowError, withRetry } from "../providers/retry.js";
import { checkFlushNeeded } from "../memory/context-flush.js";
import { injectPlanPrompt, requestPlanApproval } from "../plan.js";
import { detectLintCommand, detectTestCommand } from "../tools/lint-test.js";
import { createCheckpoint } from "../checkpoint.js";
import { resetRepeatChain } from "../guards/repeat-tool-reminder.js";
import { runLifecycleHooks } from "../user-hooks.js";

import type { AgentConfig, AgentSession, AgentResult, TurnResult, TurnHooks, TurnStopReason } from "./types.js";
import { createSession } from "./types.js";
import { consumeStream, executeToolBlocks, prefetchFirst, runToolsConcurrently } from "./stream.js";
export type { AgentConfig, AgentResult, AgentSession, TurnResult, TurnHooks, TurnStopReason };
export { createSession };

/**
 * If the history ends with an assistant message whose tool calls have no
 * results, append a cancelled result for each. Returns how many were closed.
 */
export function closeDanglingToolUses(session: AgentSession, reason = "Cancelled by user."): number {
  const messages = session.messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return 0;
  const calls = last.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  if (calls.length === 0) return 0;
  session.log.append("tool/results", {
    message: {
      role: "user",
      content: calls.map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: reason, is_error: true })),
    },
    turn: session.turns,
  });
  return calls.length;
}

export async function runTurn(
  userInput: string,
  session: AgentSession,
  config: AgentConfig,
  hooks?: TurnHooks,
): Promise<TurnResult> {
  const { provider, registry, maxTurns, verbose, costTracker } = config;
  let systemPrompt = config.systemPrompt;
  const toolDefs = registry.getDefinitions();
  const spinner = createSpinner();
  const useStream = typeof provider.chatStream === "function";
  const status = hooks?.onStatus ?? ((msg: string) => process.stderr.write(msg));

  // Plan mode: inject plan-first prompt and strip tools so the LLM
  // describes its plan before executing anything.  Works on any turn,
  // not just the first, so mid-session plan mode toggles also apply.
  let planPending = !!config.plan;
  if (planPending) {
    systemPrompt = injectPlanPrompt(systemPrompt);
  }

  // A previous turn that crashed or was killed mid-tool (or a resumed log
  // written by one) can end with unanswered tool calls; answer them first.
  closeDanglingToolUses(session);

  // Direct user input resets the repeat-call chain (repetition across it is not a loop)
  resetRepeatChain(session.repeatChain);

  // Append user message to the durable log
  session.log.append("user/message", {
    message: { role: "user", content: userInput },
    source: "user",
    turn: session.turns,
  });

  let turnToolCalls = 0;
  const turnStart = session.turns;
  // A refusal applies to automatic checks for this entire user turn.
  const deniedChecks = new Set<string>();
  // One overflow-driven compaction per model call; reset after a success.
  let overflowRecovered = false;

  const signal = hooks?.signal;
  const hookConfig = config.hookConfig ?? null;
  if (hookConfig) {
    await runLifecycleHooks(hookConfig, "UserPromptSubmit", { prompt: userInput });
  }

  // Why the loop ended; stays "max_turns" if the turn cap runs out.
  let endReason: TurnStopReason = "max_turns";
  while (session.turns - turnStart < maxTurns) {
    // Abort check
    if (signal?.aborted) { endReason = "aborted"; break; }

    // Budget check
    if (costTracker?.isOverBudget()) {
      status(`\x1b[33m[budget exceeded: ${costTracker.formatCost()}]\x1b[0m\n`);
      endReason = "budget";
      break;
    }

    if (verbose && session.turns > turnStart) {
      status(`\n${formatTurnHeader(session.turns + 1, turnToolCalls)}\n`);
    }

    // Check if context flush is needed (one-time per session) — must run before pruning
    const contextLimit = provider.contextWindow ?? 200_000;
    const flushPrompt = checkFlushNeeded(systemPrompt, session.messages, session.flushConfig);
    if (flushPrompt) {
      session.log.append("user/message", {
        message: { role: "user", content: flushPrompt },
        source: "system",
        turn: session.turns,
      });
      if (verbose) status("[context flush injected]\n");
    }

    // Prune context if approaching limit — LLM checkpoint with knowledge
    // promotion, degrading to the regex summary on any failure.
    const compactHistory = async (keepRecentTurns: number, trigger: string): Promise<boolean> => {
      const preCount = session.messages.length;
      const preTokens = estimateMessageTokens(session.messages);
      const result = await compactWithLlm(provider, systemPrompt, session.messages, {
        phrenCtx: config.phrenCtx,
        sessionId: config.sessionId,
        costTracker,
        config: config.compaction,
        pruneConfig: { contextLimit, keepRecentTurns },
        signal,
        verbose,
      });
      if (!result) return false;
      session.log.replaceMessageRange(result.plan.startIndex, result.plan.endIndex, result.plan.summaryMessage);
      const postCount = session.messages.length;
      const postTokens = estimateMessageTokens(session.messages);
      const reduction = preTokens > 0 ? ((1 - postTokens / preTokens) * 100).toFixed(0) : "0";
      const fmtPre = preTokens >= 1000 ? `${(preTokens / 1000).toFixed(1)}k` : String(preTokens);
      const fmtPost = postTokens >= 1000 ? `${(postTokens / 1000).toFixed(1)}k` : String(postTokens);
      const mode = result.usedLlm ? "llm" : "regex";
      const routed = result.promoted + result.queued > 0
        ? `, +${result.promoted} promoted, +${result.queued} queued`
        : "";
      status(`\x1b[2m[context compacted (${mode}${trigger}): ${preCount} → ${postCount} messages, ~${fmtPre} → ~${fmtPost} tokens, ${reduction}% reduction${routed}]\x1b[0m\n`);
      return true;
    };

    if (shouldPrune(systemPrompt, session.messages, { contextLimit })) {
      await compactHistory(6, "");
    }

    // For plan mode first turn, pass empty tools so LLM can't call any
    const turnTools = planPending ? [] : toolDefs;

    // Model-visible means logged: everything the provider is about to see
    // must be reconstructable from the event log. Cheap relative to a model
    // call; opt out with PHREN_AGENT_NO_INVARIANT=1 if it ever matters.
    if (process.env.PHREN_AGENT_NO_INVARIANT !== "1") {
      session.log.assertReconstructs();
    }

    let assistantContent: ContentBlock[];
    let stopReason: "end_turn" | "tool_use" | "max_tokens";

    try {
      if (useStream) {
        // Streaming path — retry the initial connection. The async generator does
        // no work until first read, so the first next() runs inside withRetry.
        const opening = await withRetry(
          async () => {
            const iterator = provider.chatStream!(systemPrompt, session.messages, turnTools, signal)[Symbol.asyncIterator]();
            const first = await iterator.next();
            return { iterator, first };
          },
          undefined,
          verbose,
          signal,
        );
        const onReasoningDelta =
          hooks?.onReasoningDelta ??
          (verbose ? (text: string) => process.stderr.write(`\x1b[2m${text}\x1b[0m`) : undefined);
        const result = await consumeStream(
          prefetchFirst(opening.iterator, opening.first),
          costTracker,
          { onTextDelta: hooks?.onTextDelta, onReasoningDelta, providerName: provider.name },
          signal,
        );
        assistantContent = result.content;
        stopReason = result.stop_reason;
      } else {
        // Batch path
        spinner.start("Thinking...");
        const response = await withRetry(
          () => provider.chat(systemPrompt, session.messages, turnTools, signal),
          undefined,
          verbose,
          signal,
        );
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
            } else {
              process.stdout.write(block.text);
              if (!block.text.endsWith("\n")) process.stdout.write("\n");
            }
          }
        }
      }
    } catch (err: unknown) {
      spinner.stop();
      // The token estimate is approximate; when the provider itself says the
      // prompt is too long, compact harder (keep 2 turns) and retry once.
      if (!overflowRecovered && !signal?.aborted && isContextOverflowError(err)) {
        overflowRecovered = true;
        status("\x1b[33m[provider reported a context overflow; compacting and retrying]\x1b[0m\n");
        if (await compactHistory(2, ", after overflow")) continue;
      }
      throw err;
    }
    overflowRecovered = false;

    if (hooks?.onReasoningDone) {
      for (const block of assistantContent) {
        if (block.type === "reasoning" && block.text) hooks.onReasoningDone(block.text);
      }
    }

    // Defensive: a provider may report tool_use with no tool blocks (e.g. a
    // malformed call dropped upstream). Executing zero blocks would append an
    // empty tool/results message, which 400s on Anthropic, so treat it as a
    // normal end of turn.
    if (stopReason === "tool_use" && !assistantContent.some((b) => b.type === "tool_use")) {
      stopReason = "end_turn";
    }

    session.log.append("assistant/message", {
      message: { role: "assistant", content: assistantContent },
      stop_reason: stopReason,
      turn: session.turns,
    });
    session.turns++;
    hooks?.onAssistantMessage?.(assistantContent, stopReason);

    // Abort check after LLM response. Tool calls the model already made must
    // still get results, or the next request carries an unpaired tool_use,
    // which Anthropic and OpenAI reject on every later turn.
    if (signal?.aborted) {
      closeDanglingToolUses(session);
      endReason = "aborted";
      break;
    }

    // Show turn cost
    if (verbose && costTracker) {
      status(`\x1b[2m  cost: ${costTracker.formatCost()}\x1b[0m\n`);
    }

    // Plan mode gate: after first response, ask for approval
    if (planPending) {
      const approve = hooks?.onPlanApproval ?? requestPlanApproval;
      const { approved, feedback } = await approve();
      if (signal?.aborted) { endReason = "aborted"; break; }
      if (!approved) {
        const msg = feedback
          ? `The user rejected the plan with feedback: ${feedback}\nPlease revise your plan.`
          : "The user rejected the plan. Task aborted.";
        if (feedback) {
          // Revisions remain in plan mode, with tools disabled, until approved.
          session.log.append("user/message", {
            message: { role: "user", content: msg },
            source: "user",
            turn: session.turns,
          });
          continue;
        }
        endReason = "plan_rejected";
        break;
      }
      // Approved — restore original system prompt and continue with tools enabled
      planPending = false;
      systemPrompt = config.systemPrompt;
      session.log.append("user/message", {
        message: { role: "user", content: "Plan approved. Proceed with execution." },
        source: "system",
        turn: session.turns,
      });
      continue;
    }

    // If max_tokens, warn user and inject continuation prompt
    if (stopReason === "max_tokens") {
      status("\x1b[33m[response truncated: max_tokens reached, requesting continuation]\x1b[0m\n");
      session.log.append("user/message", {
        message: { role: "user", content: "Your response was truncated due to length. Please continue where you left off." },
        source: "system",
        turn: session.turns,
      });
      continue;
    }

    // If no tool use, we're done
    if (stopReason !== "tool_use") { endReason = "end_turn"; break; }

    // Execute tool calls with concurrency
    const toolUseBlocks = assistantContent.filter((b): b is ToolUseBlock => b.type === "tool_use");

    // Checkpoint BEFORE the mutating batch: the tool names are known now, and
    // the snapshot must be the true pre-turn tree so /rewind can restore it.
    const mutatingTools = new Set(["edit_file", "multi_edit", "apply_patch", "write_file"]);
    const hasMutation = toolUseBlocks.some(b => mutatingTools.has(b.name));
    if (hasMutation) {
      createCheckpoint(process.cwd(), `turn-${session.turns}`);
    }

    // Log all tool calls upfront
    if (hooks?.onToolStart) {
      for (const block of toolUseBlocks) hooks.onToolStart(block.name, block.input, toolUseBlocks.length);
    } else {
      for (const block of toolUseBlocks) status(formatToolCall(block.name, block.input) + "\n");
    }

    if (!hooks?.onToolStart) spinner.start(`Running ${toolUseBlocks.length} tool${toolUseBlocks.length > 1 ? "s" : ""}...`);
    const { results: toolResults, toolCallCount } = await executeToolBlocks(toolUseBlocks, {
      registry, verbose, status, hooks, signal,
      antiPatterns: session.antiPatterns,
      captureState: session.captureState,
      phrenCtx: config.phrenCtx,
      sessionId: config.sessionId,
      repeatChain: session.repeatChain,
    });
    if (!hooks?.onToolStart) spinner.stop();

    session.toolCalls += toolCallCount;
    turnToolCalls += toolCallCount;

    // Only successful write/edit results justify checks; requested, denied,
    // failed, or cancelled mutations must never launch a follow-up command.
    const successfulMutation = toolUseBlocks.some((block) => mutatingTools.has(block.name)
      && toolResults.some((result) => result.type === "tool_result"
        && result.tool_use_id === block.id && !result.is_error));
    if (successfulMutation && !signal?.aborted && config.lintTestConfig) {
      const cwd = registry.permissionConfig.projectRoot;
      const lintCmd = config.lintTestConfig.lintCmd ?? detectLintCommand(cwd);
      const testCmd = config.lintTestConfig.testCmd ?? detectTestCommand(cwd);

      const lintFailures: string[] = [];
      for (const cmd of new Set([lintCmd, testCmd].filter(Boolean) as string[])) {
        if (signal?.aborted) break;
        if (deniedChecks.has(cmd)) continue;
        const input = { command: cmd, cwd, timeout: 60_000, description: "Verify the completed edit" };
        hooks?.onToolStart?.("shell", input, 1);
        // The same registry and scheduler preserve shell approval, hooks,
        // kernel sandbox, secret scrubbing, timeout, and turn cancellation.
        const [check] = await runToolsConcurrently([{
          type: "tool_use", id: `post-edit-${session.turns}`, name: "shell", input,
        }], registry, signal);
        session.toolCalls++;
        turnToolCalls++;
        if (!check.cancelled) hooks?.onToolEnd?.("shell", input, check.output, check.is_error, check.durationMs);
        if (check.permissionDenied) deniedChecks.add(cmd);
        if (check.is_error) {
          if (verbose) status(`\x1b[33m[post-edit check failed: ${cmd}]\x1b[0m\n`);
          lintFailures.push(`Post-edit check failed (${cmd}):\n${check.output.slice(0, 2000)}`);
        }
      }
      if (lintFailures.length > 0) {
        // Inject as plain text in the tool results user message (not as a fabricated tool_result)
        toolResults.push({
          type: "text",
          text: lintFailures.join("\n\n"),
        } as ContentBlock);
      }
    }

    // Add tool results as a user message
    session.log.append("tool/results", {
      message: { role: "user", content: toolResults },
      turn: session.turns,
    });
    hooks?.onToolResults?.(toolResults);

    // Steering input injection (TUI mid-turn input)
    const steer = hooks?.getSteeringInput?.();
    if (steer) {
      resetRepeatChain(session.repeatChain);
      session.log.append("user/message", {
        message: { role: "user", content: steer },
        source: "steer",
        turn: session.turns,
      });
    }
  }

  // Extract text from the last assistant message in this turn
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
  let text = "";
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    text = lastAssistant.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else if (lastAssistant && typeof lastAssistant.content === "string") {
    text = lastAssistant.content;
  }

  if (hookConfig) {
    await runLifecycleHooks(hookConfig, "Stop", {});
  }

  return { text, turns: session.turns - turnStart, toolCalls: turnToolCalls, stopReason: signal?.aborted ? "aborted" : endReason };
}

export async function runAgent(task: string, config: AgentConfig): Promise<AgentResult> {
  const contextLimit = config.provider.contextWindow ?? 200_000;
  const session = createSession(contextLimit);
  const result = await runTurn(task, session, config, config.hooks);
  return {
    finalText: result.text,
    turns: result.turns,
    toolCalls: result.toolCalls,
    totalCost: config.costTracker?.formatCost(),
    messages: session.messages,
    session,
  };
}
