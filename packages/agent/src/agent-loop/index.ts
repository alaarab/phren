import type { ContentBlock, InvalidToolCall, TokenUsage, ToolUseBlock } from "../providers/types.js";
import { createSpinner, formatTurnHeader, formatToolCall } from "../spinner.js";
import { planToolResultClearing } from "../context/clear-tool-results.js";
import { contextTokens, reportedContext } from "../context/usage.js";
import { compactWithLlm } from "../context/compactor.js";
import { estimateMessageTokens } from "../context/token-counter.js";
import { isContextOverflowError, withRetry } from "../providers/retry.js";
import { injectPlanPrompt, requestPlanApproval } from "../plan.js";
import { READ_ONLY_TOOLS } from "../permissions/checker.js";
import { detectLintCommand, detectTestCommand } from "../tools/lint-test.js";
import { createCheckpoint } from "../checkpoint.js";
import { resetRepeatChain } from "../guards/repeat-tool-reminder.js";
import { runLifecycleHooks } from "../user-hooks.js";
import { recordTokenUsage } from "../cost.js";

import type { AgentConfig, AgentSession, AgentResult, TurnResult, TurnHooks, TurnStopReason } from "./types.js";
import { createSession } from "./types.js";
import { consumeStream, executeToolBlocks, runToolsConcurrently } from "./stream.js";
export type { AgentConfig, AgentResult, AgentSession, TurnResult, TurnHooks, TurnStopReason };
export { createSession };

/**
 * If the history ends with an assistant message whose tool calls have no
 * results, append a cancelled result for each. Returns how many were closed.
 */
/** How many times one turn's Stop hooks may send the model back. */
const MAX_STOP_BLOCKS = 5;

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
  // While a plan is pending the model may look but not touch.
  const planToolDefs = toolDefs.filter((d) => READ_ONLY_TOOLS.has(d.name));
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

  // UserPromptSubmit hooks may block the prompt (exit 2) or add context to it.
  const hookConfig = config.hookConfig ?? null;
  const promptHooks = hookConfig ? await runLifecycleHooks(hookConfig, "UserPromptSubmit", { prompt: userInput }) : null;
  if (promptHooks?.blocked) {
    (hooks?.onStatus ?? ((msg: string) => process.stderr.write(msg)))(`\x1b[33m[prompt blocked by a UserPromptSubmit hook: ${promptHooks.reason}]\x1b[0m\n`);
    return { text: "", turns: 0, toolCalls: 0, stopReason: "hook_blocked" };
  }
  const promptContent = promptHooks?.context ? `${userInput}\n\n<user-prompt-submit-hook>\n${promptHooks.context}\n</user-prompt-submit-hook>` : userInput;

  // Append user message to the durable log
  const prompted = session.log.append("user/message", {
    message: { role: "user", content: promptContent },
    source: "user",
    turn: session.turns,
  });
  // Phren Hook streams the text block being written from this sidecar; the
  // turn is named by the time of the prompt that started it.
  const preview = config.livePreview?.(session.log.header.sessionId);

  let turnToolCalls = 0;
  const turnStart = session.turns;
  // A refusal applies to automatic checks for this entire user turn.
  const deniedChecks = new Set<string>();
  // One overflow-driven compaction per model call; reset after a success.
  let overflowRecovered = false;

  const signal = hooks?.signal;
  // Times a Stop hook sent the model back to work in this turn.
  let stopBlocks = 0;
  let stopHooksRan = false;

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

    // Prune context if approaching limit — LLM checkpoint with knowledge
    // promotion, degrading to the regex summary on any failure. (There is no
    // separate "summarize what you learned" prompt: injected mid-task, the
    // model answered it and ended the turn, and compaction already promotes
    // knowledge to phren out of band.)
    const contextLimit = provider.contextWindow ?? 200_000;
    const compactHistory = async (keepRecentTurns: number, trigger: string): Promise<boolean> => {
      if (hookConfig) await runLifecycleHooks(hookConfig, "PreCompact", { trigger: "auto" });
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
        tools: toolDefs,
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

    // Past 75% of the window (by the provider's own count when there is
    // one), first clear old tool output; compact only if that frees too little.
    const usedTokens = () => contextTokens(systemPrompt, session.messages, session.log, session.reportedContext);
    if (usedTokens() > contextLimit * 0.75) {
      const before = usedTokens();
      const cleared = planToolResultClearing(session.messages);
      for (const { index, message } of cleared) session.log.replaceMessageRange(index, index, message);
      const after = usedTokens();
      if (cleared.length > 0) {
        status(`\x1b[2m[cleared ${cleared.length === 1 ? "old tool output in 1 message" : `old tool output in ${cleared.length} messages`}: ~${Math.round(before / 1000)}k → ~${Math.round(after / 1000)}k tokens]\x1b[0m\n`);
      }
      if (after > contextLimit * 0.6) await compactHistory(6, "");
    }

    // For plan mode first turn, pass empty tools so LLM can't call any
    const turnTools = planPending ? planToolDefs : toolDefs;

    // Model-visible means logged: everything the provider is about to see
    // must be reconstructable from the event log. Cheap relative to a model
    // call; opt out with PHREN_AGENT_NO_INVARIANT=1 if it ever matters.
    if (process.env.PHREN_AGENT_NO_INVARIANT !== "1") {
      session.log.assertReconstructs();
    }

    let assistantContent: ContentBlock[];
    let stopReason: "end_turn" | "tool_use" | "max_tokens";
    let invalidToolCalls: InvalidToolCall[] = [];
    let usage: TokenUsage | undefined;

    try {
      if (useStream) {
        // Streaming path — the whole request is retried, not just opening it:
        // a stream that drops, stalls into an incomplete end, or reports a
        // retryable failure mid-response is requested again. Nothing has run
        // yet (tools execute after the stream completes), so the only cost is
        // the partial text already shown, dropped before the backoff wait.
        const onReasoningDelta =
          hooks?.onReasoningDelta ??
          (verbose ? (text: string) => process.stderr.write(`\x1b[2m${text}\x1b[0m`) : undefined);
        const onTextDelta = hooks?.onTextDelta ?? process.stdout.write.bind(process.stdout);
        // Text this attempt has shown, for UIs that cannot take it back.
        let shown = "";
        const onRetry = () => {
          if (hooks?.onStreamRetry) {
            hooks.onStreamRetry();
          } else if (shown && !shown.endsWith("\n")) {
            // Plain stdout (the REPL, one-shot) cannot erase the abandoned
            // text; end its line so the restarted reply begins on its own.
            onTextDelta("\n");
          }
          status(shown
            ? "\x1b[33m[model request failed; retrying, the reply starts again]\x1b[0m\n"
            : "\x1b[33m[model request failed; retrying]\x1b[0m\n");
          shown = "";
          // The phone's live preview drops the abandoned attempt's text too.
          preview?.clear();
        };
        const result = await withRetry(
          async () => {
            preview?.start(prompted.time);
            return consumeStream(
              provider.chatStream!(systemPrompt, session.messages, turnTools, signal),
              costTracker,
              {
                onTextDelta: (text: string) => { shown += text; onTextDelta(text); preview?.append(text); },
                onReasoningDelta,
                providerName: provider.name,
              },
              signal,
            );
          },
          { onRetry },
          verbose,
          signal,
        );
        assistantContent = result.content;
        stopReason = result.stop_reason;
        invalidToolCalls = result.invalidToolCalls;
        usage = result.usage;
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
        invalidToolCalls = response.invalidToolCalls ?? [];
        usage = response.usage;

        // Track cost from batch response
        if (costTracker && response.usage) {
          recordTokenUsage(costTracker, response.usage);
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
      preview?.clear();
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
    session.reportedContext = reportedContext(usage, session.log) ?? session.reportedContext;
    // Only after the message is in the log, so a reader never sees neither.
    preview?.clear();
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

    // Plan mode gate: once the model presents its plan (a reply without tool
    // calls), ask for approval. Read-only calls before that just run.
    if (planPending && stopReason === "end_turn") {
      const approve = hooks?.onPlanApproval ?? requestPlanApproval;
      const { approved, feedback } = await approve();
      if (signal?.aborted) { endReason = "aborted"; break; }
      if (!approved) {
        const msg = feedback
          ? `The user rejected the plan with feedback: ${feedback}\nPlease revise your plan.`
          : "The user rejected the plan. Task aborted.";
        if (feedback) {
          // Revisions remain in plan mode, read-only, until approved.
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

    // If max_tokens, warn user and inject continuation prompt. Complete tool
    // calls in the truncated response are not run (the response may have been
    // cut mid-batch), but each still needs a result or every later request
    // carries an unpaired tool_use.
    if (stopReason === "max_tokens") {
      status("\x1b[33m[response truncated: max_tokens reached, requesting continuation]\x1b[0m\n");
      closeDanglingToolUses(session, "Not executed: your response was truncated at max_tokens. Issue the call again if it is still needed.");
      session.log.append("user/message", {
        message: { role: "user", content: "Your response was truncated due to length. Please continue where you left off." },
        source: "system",
        turn: session.turns,
      });
      continue;
    }

    // If no tool use, we're done
    if (stopReason !== "tool_use") {
      // A Stop hook that exits 2 sends the model back with its reason (tests
      // still failing, say); stop_hook_active tells it it already did once.
      if (hookConfig && stopBlocks < MAX_STOP_BLOCKS && !signal?.aborted) {
        const stop = await runLifecycleHooks(hookConfig, "Stop", { stop_hook_active: stopBlocks > 0 });
        if (stop.blocked) {
          stopBlocks++;
          status(`\x1b[2m[Stop hook: ${stop.reason}]\x1b[0m\n`);
          session.log.append("user/message", {
            message: { role: "user", content: `A Stop hook asked you to keep going: ${stop.reason}` },
            source: "system",
            turn: session.turns,
          });
          continue;
        }
        stopHooksRan = true;
      }
      endReason = "end_turn";
      break;
    }

    // Execute tool calls with concurrency. Calls whose arguments were not
    // valid JSON are answered with an error instead of being run.
    const toolUseBlocks = assistantContent.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const invalidById = new Map(invalidToolCalls.map((call) => [call.id, call]));
    // Only offered the read-only tools, a model can still name another one.
    const planRefused = new Set(planPending ? toolUseBlocks.filter((b) => !READ_ONLY_TOOLS.has(b.name)).map((b) => b.id) : []);
    const runnableBlocks = toolUseBlocks.filter((b) => !invalidById.has(b.id) && !planRefused.has(b.id));

    // Checkpoint BEFORE the mutating batch: the tool names are known now, and
    // the snapshot must be the true pre-turn tree so /rewind can restore it.
    const mutatingTools = new Set(["edit_file", "multi_edit", "apply_patch", "write_file"]);
    const hasMutation = runnableBlocks.some(b => mutatingTools.has(b.name));
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
    const { results: executedResults, toolCallCount } = await executeToolBlocks(runnableBlocks, {
      registry, verbose, status, hooks, signal,
      antiPatterns: session.antiPatterns,
      captureState: session.captureState,
      phrenCtx: config.phrenCtx,
      sessionId: config.sessionId,
      repeatChain: session.repeatChain,
    });
    if (!hooks?.onToolStart) spinner.stop();

    // Results in the model's call order, invalid calls answered in place.
    const resultById = new Map(
      executedResults.flatMap((r) => (r.type === "tool_result" ? [[r.tool_use_id, r] as const] : [])),
    );
    const toolResults: ContentBlock[] = toolUseBlocks.map((block) => {
      if (planRefused.has(block.id)) {
        const output = `Not run: plan mode allows only read-only tools until the user approves the plan. Finish the plan without calling ${block.name}.`;
        hooks?.onToolEnd?.(block.name, block.input, output, true, 0);
        return { type: "tool_result", tool_use_id: block.id, content: output, is_error: true };
      }
      const invalid = invalidById.get(block.id);
      if (!invalid) return resultById.get(block.id)!;
      const sample = invalid.raw.length > 300 ? `${invalid.raw.slice(0, 300)}…` : invalid.raw;
      const output = `Not run: the arguments for ${block.name} were not valid JSON (${invalid.error}). ` +
        `Call the tool again with a JSON object of arguments. You sent: ${sample}`;
      hooks?.onToolEnd?.(block.name, block.input, output, true, 0);
      return { type: "tool_result", tool_use_id: block.id, content: output, is_error: true };
    });

    session.toolCalls += toolCallCount + invalidById.size + planRefused.size;
    turnToolCalls += toolCallCount + invalidById.size + planRefused.size;

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

  if (hookConfig && !stopHooksRan) {
    await runLifecycleHooks(hookConfig, "Stop", { stop_hook_active: stopBlocks > 0 });
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
