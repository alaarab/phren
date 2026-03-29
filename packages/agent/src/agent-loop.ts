import type { LlmProvider, LlmMessage, ContentBlock, ToolUseBlock, StreamDelta, EffortLevel, LlmRequestOptions } from "./providers/types.js";
import type { PhrenContext } from "./memory/context.js";
import type { CostTracker } from "./cost.js";
import type { HookManager } from "./hooks.js";
import { ToolRegistry } from "./tools/registry.js";
import { createSpinner, formatTurnHeader, formatToolCall } from "./spinner.js";
import { searchErrorRecovery } from "./memory/error-recovery.js";
import { shouldPrune, pruneMessages } from "./context/pruner.js";
import { withRetry } from "./providers/retry.js";
import { createCaptureState, analyzeAndCapture, type CaptureState } from "./memory/auto-capture.js";
import { AntiPatternTracker } from "./memory/anti-patterns.js";
import { createFlushConfig, checkFlushNeeded, type FlushConfig } from "./memory/context-flush.js";
import { injectPlanPrompt, requestPlanApproval } from "./plan.js";
import { detectLintCommand, detectTestCommand, runPostEditCheck, type LintTestConfig } from "./tools/lint-test.js";
import { createCheckpoint } from "./checkpoint.js";

const MAX_TOOL_CONCURRENCY = 5;

export interface AgentConfig {
  provider: LlmProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  maxTurns: number;
  verbose: boolean;
  phrenCtx?: PhrenContext | null;
  costTracker?: CostTracker | null;
  plan?: boolean;
  lintTestConfig?: LintTestConfig;
  hooks?: TurnHooks;
  /** Reasoning effort level. Default: "high". */
  effort?: EffortLevel;
  /** Agent-loop hook manager for PreToolUse, PostToolUse, Stop hooks. */
  hookManager?: HookManager | null;
  /** Custom compaction instructions for context pruning. */
  compactionInstructions?: string;
}

export interface AgentResult {
  finalText: string;
  turns: number;
  toolCalls: number;
  totalCost?: string;
  messages: LlmMessage[];
}

export interface AgentSession {
  messages: LlmMessage[];
  turns: number;
  toolCalls: number;
  captureState: CaptureState;
  antiPatterns: AntiPatternTracker;
  flushConfig: FlushConfig;
}

export function createSession(contextLimit?: number): AgentSession {
  return {
    messages: [],
    turns: 0,
    toolCalls: 0,
    captureState: createCaptureState(),
    antiPatterns: new AntiPatternTracker(),
    flushConfig: createFlushConfig(contextLimit ?? 200_000),
  };
}

export interface TurnResult {
  text: string;
  turns: number;
  toolCalls: number;
}

/** UI hooks for pluggable rendering. Defaults write to stdout/stderr. */
export interface TurnHooks {
  /** Streaming text token. Default: process.stdout.write(text) */
  onTextDelta?: (text: string) => void;
  /** Final newline after a streaming text block. Default: write "\n" if needed */
  onTextDone?: (text: string) => void;
  /** Non-streaming text block output. Default: process.stdout.write */
  onTextBlock?: (text: string) => void;
  /** Before tool execution. Default: spinner */
  onToolStart?: (name: string, input: Record<string, unknown>, count: number) => void;
  /** After tool execution. Default: verbose log */
  onToolEnd?: (name: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number) => void;
  /** Status messages (prune, flush, budget, cost). Default: stderr */
  onStatus?: (msg: string) => void;
  /** Mid-turn steering input injection. Return null for none. */
  getSteeringInput?: () => string | null;
}

/** Run tool blocks with concurrency limit. */
async function runToolsConcurrently(
  blocks: ToolUseBlock[],
  registry: ToolRegistry,
): Promise<Array<{ block: ToolUseBlock; output: string; is_error: boolean }>> {
  const results: Array<{ block: ToolUseBlock; output: string; is_error: boolean }> = [];
  for (let i = 0; i < blocks.length; i += MAX_TOOL_CONCURRENCY) {
    const batch = blocks.slice(i, i + MAX_TOOL_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (block) => {
        const TOOL_TIMEOUT_MS = 120_000;
        try {
          const result = await Promise.race([
            registry.execute(block.name, block.input),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Tool '${block.name}' timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS),
            ),
          ]);
          return { block, output: result.output, is_error: !!result.is_error };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { block, output: msg, is_error: true };
        }
      }),
    );
    results.push(...batchResults);
  }
  return results;
}

/** Consume a chatStream into ContentBlock[] + stop_reason, streaming text via callback. */
async function consumeStream(
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
  const requestOptions: LlmRequestOptions = {
    effort: config.effort ?? "high",
    cacheEnabled: provider.name === "anthropic", // Enable caching for Anthropic
  };

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
      if (verbose) status("[context flush injected]\n");
    }

    // Prune context if approaching limit
    if (shouldPrune(systemPrompt, session.messages, { contextLimit })) {
      session.messages = pruneMessages(session.messages, {
        contextLimit,
        keepRecentTurns: 6,
        compactionInstructions: config.compactionInstructions,
      });
      if (verbose) status("[context pruned]\n");
    }

    // For plan mode first turn, pass empty tools so LLM can't call any
    const turnTools = planPending ? [] : toolDefs;

    let assistantContent: ContentBlock[];
    let stopReason: "end_turn" | "tool_use" | "max_tokens";

    if (useStream) {
      // Streaming path — retry the initial connection (before consuming deltas)
      const stream = await withRetry(
        async () => provider.chatStream!(systemPrompt, session.messages, turnTools, requestOptions),
        undefined,
        verbose,
      );
      const result = await consumeStream(stream, costTracker, hooks?.onTextDelta);
      assistantContent = result.content;
      stopReason = result.stop_reason;
    } else {
      // Batch path
      spinner.start("Thinking...");
      const response = await withRetry(
        () => provider.chat(systemPrompt, session.messages, turnTools, requestOptions),
        undefined,
        verbose,
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

    session.messages.push({ role: "assistant", content: assistantContent });
    session.turns++;

    // Show turn cost
    if (verbose && costTracker) {
      status(`\x1b[2m  cost: ${costTracker.formatCost()}\x1b[0m\n`);
    }

    // Plan mode gate: after first response, ask for approval
    if (planPending) {
      planPending = false;
      const { approved, feedback } = await requestPlanApproval();
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
    if (stopReason !== "tool_use") break;

    // Execute tool calls with concurrency
    const toolUseBlocks = assistantContent.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const toolResults: ContentBlock[] = [];

    // Log all tool calls upfront
    if (hooks?.onToolStart) {
      for (const block of toolUseBlocks) hooks.onToolStart(block.name, block.input, toolUseBlocks.length);
    } else {
      for (const block of toolUseBlocks) status(formatToolCall(block.name, block.input) + "\n");
    }

    // Run PreToolUse hooks — may block individual tools
    if (config.hookManager?.hasHooks("PreToolUse")) {
      for (let bi = toolUseBlocks.length - 1; bi >= 0; bi--) {
        const block = toolUseBlocks[bi];
        const hookResult = await config.hookManager.runHooks({
          event: "PreToolUse",
          toolName: block.name,
          toolInput: block.input,
        });
        if (!hookResult.allowed) {
          // Remove blocked tool and add a synthetic error result
          toolUseBlocks.splice(bi, 1);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Blocked by hook: ${hookResult.error ?? "denied"}`,
            is_error: true,
          });
          if (verbose) status(`\x1b[33m[hook blocked: ${block.name}]\x1b[0m\n`);
        }
      }
    }

    if (!hooks?.onToolStart) spinner.start(`Running ${toolUseBlocks.length} tool${toolUseBlocks.length > 1 ? "s" : ""}...`);
    const execResults = await runToolsConcurrently(toolUseBlocks, registry);
    if (!hooks?.onToolStart) spinner.stop();

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
          if (recovery) finalOutput += recovery;
        } catch { /* best effort */ }

        // Auto-capture error patterns
        try {
          await analyzeAndCapture(config.phrenCtx, output, session.captureState);
        } catch { /* best effort */ }
      }

      // Run PostToolUse hooks
      if (config.hookManager?.hasHooks("PostToolUse")) {
        try {
          await config.hookManager.runHooks({
            event: "PostToolUse",
            toolName: block.name,
            toolInput: block.input,
            toolOutput: finalOutput,
            isError: is_error,
          });
        } catch { /* best effort */ }
      }

      if (hooks?.onToolEnd) {
        hooks.onToolEnd(block.name, block.input, finalOutput, is_error, 0);
      } else if (verbose) {
        const preview = finalOutput.slice(0, 200);
        status(`\x1b[2m  ← ${is_error ? "ERROR: " : ""}${preview}${finalOutput.length > 200 ? "..." : ""}\x1b[0m\n`);
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

      const lintFailures: string[] = [];
      for (const cmd of [lintCmd, testCmd].filter(Boolean) as string[]) {
        const check = runPostEditCheck(cmd, cwd);
        if (!check.passed) {
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
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else if (lastAssistant && typeof lastAssistant.content === "string") {
    text = lastAssistant.content;
  }

  return { text, turns: session.turns - turnStart, toolCalls: turnToolCalls };
}

/** One-shot agent run — thin wrapper around createSession + runTurn. */
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
  };
}
