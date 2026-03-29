/**
 * Slash command dispatch for the REPL.
 */
import type { AgentSession } from "./agent-loop.js";
import type { LlmMessage } from "./providers/types.js";
import { estimateTokens, estimateMessageTokens } from "./context/token-counter.js";
import { pruneMessages } from "./context/pruner.js";
import type { AgentSpawner } from "./multi/spawner.js";
import { listPresets, loadPreset, savePreset, deletePreset, formatPreset } from "./multi/presets.js";
import { renderMarkdown } from "./multi/markdown.js";
import { showModelPicker, type PickerResult } from "./multi/model-picker.js";
import { formatProviderList, formatModelAddHelp, addCustomModel, removeCustomModel, type ReasoningLevel } from "./multi/provider-manager.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const HISTORY_MAX_LINES = 5;

export interface CommandContext {
  session: AgentSession;
  costTracker?: { totalCost: number; inputTokens: number; outputTokens: number };
  contextLimit: number;
  undoStack: LlmMessage[][];
  spawner?: AgentSpawner;
  /** Current provider name for /model command */
  providerName?: string;
  /** Current model ID for /model command */
  currentModel?: string;
  /** Callback when model/reasoning changes */
  onModelChange?: (result: PickerResult) => void;
  /** Callback to update compaction instructions in agent config */
  onCompactionInstructions?: (instructions: string) => void;
  /** LLM provider for /btw side conversations */
  provider?: import("./providers/types.js").LlmProvider;
  /** System prompt for /btw side conversations */
  systemPrompt?: string;
}

export function createCommandContext(session: AgentSession, contextLimit: number): CommandContext {
  return {
    session,
    contextLimit,
    undoStack: [],
  };
}

/** Truncate text to N lines, appending [+M lines] if overflow. */
function truncateText(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const overflow = lines.length - maxLines;
  return lines.slice(0, maxLines).join("\n") + `\n${DIM}[+${overflow} lines]${RESET}`;
}

/**
 * Try to handle a slash command. Returns true if the input was a command.
 */
export function handleCommand(input: string, ctx: CommandContext): boolean {
  const parts = input.trim().split(/\s+/);
  const name = parts[0];

  switch (name) {
    case "/help":
      process.stderr.write(`${DIM}Commands:
  /help       Show this help
  /model      Interactive model + reasoning picker
  /model add <id>  Add a custom model
  /model remove <id>  Remove a custom model
  /provider   Show configured providers + auth status
  /turns      Show turn and tool call counts
  /clear      Clear conversation history
  /cost       Show token usage and estimated cost
  /context    Show context usage breakdown
  /plan       Show conversation plan (tool calls so far)
  /undo       Undo last user message and response
  /history [n|full]  Show last N messages (default 10) with rich formatting
  /compact [instructions]  Compact conversation with optional retention instructions
  /btw <question>  Side question without polluting conversation history
  /mode       Toggle input mode (steering ↔ queue)
  /effort [low|medium|high|max]  Show or set effort level
  /spawn <name> <task>  Spawn a background agent
  /agents     List running agents
  /preset [name|save|delete|list]  Config presets
  /exit       Exit the REPL${RESET}\n`);
      return true;

    case "/model": {
      const sub = parts[1]?.toLowerCase();

      // /model add <id> [provider=X] [context=N] [reasoning=X]
      if (sub === "add") {
        const modelId = parts[2];
        if (!modelId) {
          process.stderr.write(formatModelAddHelp() + "\n");
          return true;
        }
        let provider = ctx.providerName ?? "openrouter";
        let contextWindow = 128_000;
        let reasoning: ReasoningLevel = null;
        const reasoningRange: ReasoningLevel[] = [];
        for (const arg of parts.slice(3)) {
          const [k, v] = arg.split("=", 2);
          if (k === "provider") provider = v;
          else if (k === "context") contextWindow = parseInt(v, 10) || 128_000;
          else if (k === "reasoning") {
            reasoning = v as ReasoningLevel;
            reasoningRange.push("low", "medium", "high");
            if (v === "max") reasoningRange.push("max");
          }
        }
        addCustomModel(modelId, provider, { contextWindow, reasoning, reasoningRange });
        process.stderr.write(`${GREEN}→ Added ${modelId} to ${provider}${RESET}\n`);
        return true;
      }

      // /model remove <id>
      if (sub === "remove" || sub === "rm") {
        const modelId = parts[2];
        if (!modelId) {
          process.stderr.write(`${DIM}Usage: /model remove <model-id>${RESET}\n`);
          return true;
        }
        const ok = removeCustomModel(modelId);
        process.stderr.write(ok ? `${GREEN}→ Removed ${modelId}${RESET}\n` : `${DIM}Model "${modelId}" not found in custom models.${RESET}\n`);
        return true;
      }

      // /model (no sub) — interactive picker
      if (!ctx.providerName) {
        process.stderr.write(`${DIM}Provider not configured. Start with --provider to set one.${RESET}\n`);
        return true;
      }
      showModelPicker(ctx.providerName, ctx.currentModel, process.stdout).then((result) => {
        if (result && ctx.onModelChange) {
          ctx.onModelChange(result);
          const reasoningLabel = result.reasoning ? ` (reasoning: ${result.reasoning})` : "";
          process.stderr.write(`${GREEN}→ ${result.model}${reasoningLabel}${RESET}\n`);
        } else if (result) {
          process.stderr.write(`${DIM}Model selected: ${result.model} — restart to apply.${RESET}\n`);
        }
      });
      return true;
    }

    case "/provider": {
      process.stderr.write(formatProviderList());
      return true;
    }

    case "/turns": {
      const tokens = estimateMessageTokens(ctx.session.messages);
      const pct = ctx.contextLimit > 0 ? ((tokens / ctx.contextLimit) * 100).toFixed(1) : "?";
      const costLine = ctx.costTracker ? `  Cost: $${ctx.costTracker.totalCost.toFixed(4)}` : "";
      process.stderr.write(
        `${DIM}Turns: ${ctx.session.turns}  Tool calls: ${ctx.session.toolCalls}  ` +
        `Messages: ${ctx.session.messages.length}  Tokens: ~${tokens} (${pct}%)${costLine}${RESET}\n`
      );
      return true;
    }

    case "/clear":
      ctx.session.messages.length = 0;
      ctx.session.turns = 0;
      ctx.session.toolCalls = 0;
      ctx.undoStack.length = 0;
      process.stderr.write(`${DIM}Conversation cleared.${RESET}\n`);
      return true;

    case "/cost": {
      const ct = ctx.costTracker;
      if (ct) {
        process.stderr.write(`${DIM}Tokens — input: ${ct.inputTokens}  output: ${ct.outputTokens}  est. cost: $${ct.totalCost.toFixed(4)}${RESET}\n`);
      } else {
        process.stderr.write(`${DIM}Cost tracking not available.${RESET}\n`);
      }
      return true;
    }

    case "/plan": {
      const tools: string[] = [];
      for (const msg of ctx.session.messages) {
        if (typeof msg.content !== "string") {
          for (const block of msg.content) {
            if (block.type === "tool_use") {
              tools.push(block.name);
            }
          }
        }
      }
      if (tools.length === 0) {
        process.stderr.write(`${DIM}No tool calls yet.${RESET}\n`);
      } else {
        process.stderr.write(`${DIM}Tool calls (${tools.length}): ${tools.join(" → ")}${RESET}\n`);
      }
      return true;
    }

    case "/undo": {
      if (ctx.session.messages.length < 2) {
        process.stderr.write(`${DIM}Nothing to undo.${RESET}\n`);
        return true;
      }
      // Remove messages back to the previous user message
      let removed = 0;
      while (ctx.session.messages.length > 0) {
        const last = ctx.session.messages.pop();
        removed++;
        if (last?.role === "user" && typeof last.content === "string") break;
      }
      process.stderr.write(`${DIM}Undid ${removed} messages.${RESET}\n`);
      return true;
    }

    case "/history": {
      const msgs = ctx.session.messages;
      if (msgs.length === 0) {
        process.stderr.write(`${DIM}No messages yet.${RESET}\n`);
        return true;
      }

      const arg = parts[1];
      const isFull = arg === "full";
      const count = isFull ? msgs.length : Math.min(parseInt(arg, 10) || 10, msgs.length);
      const slice = msgs.slice(-count);

      const tokens = estimateMessageTokens(msgs);
      const pct = ctx.contextLimit > 0 ? ((tokens / ctx.contextLimit) * 100).toFixed(1) : "?";
      process.stderr.write(`${DIM}── History (${slice.length}/${msgs.length} messages, ~${tokens} tokens, ${pct}% context) ──${RESET}\n`);

      for (const msg of slice) {
        if (msg.role === "user") {
          if (typeof msg.content === "string") {
            const truncated = truncateText(msg.content, isFull ? Infinity : HISTORY_MAX_LINES);
            process.stderr.write(`\n${CYAN}${BOLD}You:${RESET} ${truncated}\n`);
          } else {
            // Tool results
            for (const block of msg.content) {
              if (block.type === "tool_result") {
                const icon = block.is_error ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
                const preview = (block.content ?? "").slice(0, 80).replace(/\n/g, " ");
                process.stderr.write(`${DIM}  ${icon} tool_result ${preview}${preview.length >= 80 ? "..." : ""}${RESET}\n`);
              } else if (block.type === "text") {
                process.stderr.write(`${DIM}  ${(block as { text: string }).text.slice(0, 100)}${RESET}\n`);
              }
            }
          }
        } else if (msg.role === "assistant") {
          if (typeof msg.content === "string") {
            const rendered = isFull ? renderMarkdown(msg.content) : truncateText(msg.content, HISTORY_MAX_LINES);
            process.stderr.write(`\n${GREEN}${BOLD}Agent:${RESET}\n${rendered}\n`);
          } else {
            for (const block of msg.content) {
              if (block.type === "text") {
                const text = (block as { text: string }).text;
                const rendered = isFull ? renderMarkdown(text) : truncateText(text, HISTORY_MAX_LINES);
                process.stderr.write(`\n${GREEN}${BOLD}Agent:${RESET}\n${rendered}\n`);
              } else if (block.type === "tool_use") {
                const tb = block as { name: string; input: Record<string, unknown> };
                const inputPreview = JSON.stringify(tb.input).slice(0, 60);
                process.stderr.write(`${YELLOW}  ⚡ ${tb.name}${RESET}${DIM}(${inputPreview})${RESET}\n`);
              }
            }
          }
        }
      }

      process.stderr.write(`${DIM}── end ──${RESET}\n`);
      return true;
    }

    case "/compact": {
      const customInstructions = parts.slice(1).join(" ").trim() || undefined;
      if (customInstructions && ctx.onCompactionInstructions) {
        ctx.onCompactionInstructions(customInstructions);
      }
      const before = ctx.session.messages.length;
      ctx.session.messages = pruneMessages(ctx.session.messages, {
        contextLimit: ctx.contextLimit,
        keepRecentTurns: 4,
        compactionInstructions: customInstructions,
      });
      const after = ctx.session.messages.length;
      if (customInstructions) {
        process.stderr.write(`${DIM}Context compacted with custom instructions: ${before} → ${after} messages.${RESET}\n`);
      } else {
        process.stderr.write(`${DIM}Compacted: ${before} → ${after} messages.${RESET}\n`);
      }
      return true;
    }

    case "/context": {
      const msgs = ctx.session.messages;
      const totalTokens = estimateMessageTokens(msgs);
      const pct = ctx.contextLimit > 0 ? ((totalTokens / ctx.contextLimit) * 100).toFixed(1) : "?";

      // Count message types
      let userMessages = 0;
      let assistantMessages = 0;
      let toolResults = 0;
      let systemTokens = 0;
      let conversationTokens = 0;
      let toolResultTokens = 0;

      for (const msg of msgs) {
        if (msg.role === "user") {
          if (typeof msg.content === "string") {
            userMessages++;
            conversationTokens += estimateMessageTokens([msg]);
          } else {
            // Tool result blocks
            for (const block of msg.content) {
              if (block.type === "tool_result") {
                toolResults++;
                toolResultTokens += estimateTokens(block.content ?? "");
              } else if (block.type === "text") {
                conversationTokens += estimateTokens((block as { text: string }).text);
              }
            }
          }
        } else if (msg.role === "assistant") {
          assistantMessages++;
          if (typeof msg.content === "string") {
            conversationTokens += estimateMessageTokens([msg]);
          } else {
            for (const block of msg.content) {
              if (block.type === "text") {
                conversationTokens += estimateTokens((block as { text: string }).text);
              } else if (block.type === "tool_use") {
                conversationTokens += estimateTokens(JSON.stringify((block as { input: unknown }).input));
              }
            }
          }
        }
      }

      // Estimate system prompt tokens if available
      if (ctx.systemPrompt) {
        systemTokens = estimateTokens(ctx.systemPrompt);
      }

      process.stderr.write(`${DIM}── Context Usage ──${RESET}\n`);
      process.stderr.write(`${DIM}  Total:          ~${totalTokens} / ${ctx.contextLimit} tokens (${pct}%)${RESET}\n`);
      process.stderr.write(`${DIM}  Messages:       ${msgs.length} total${RESET}\n`);
      process.stderr.write(`${DIM}    User:         ${userMessages}${RESET}\n`);
      process.stderr.write(`${DIM}    Assistant:     ${assistantMessages}${RESET}\n`);
      process.stderr.write(`${DIM}    Tool results:  ${toolResults}${RESET}\n`);
      process.stderr.write(`${DIM}  Breakdown:${RESET}\n`);
      if (systemTokens > 0) {
        process.stderr.write(`${DIM}    System prompt: ~${systemTokens} tokens${RESET}\n`);
      }
      process.stderr.write(`${DIM}    Conversation:  ~${conversationTokens} tokens${RESET}\n`);
      process.stderr.write(`${DIM}    Tool results:  ~${toolResultTokens} tokens${RESET}\n`);
      process.stderr.write(`${DIM}── end ──${RESET}\n`);
      return true;
    }

    case "/btw": {
      const question = parts.slice(1).join(" ").trim();
      if (!question) {
        process.stderr.write(`${DIM}Usage: /btw <question>${RESET}\n`);
        return true;
      }
      if (!ctx.provider) {
        process.stderr.write(`${DIM}Provider not available for side conversations.${RESET}\n`);
        return true;
      }
      const sideSystemPrompt = ctx.systemPrompt
        ? ctx.systemPrompt + "\n\nThis is a brief side question. Answer concisely."
        : "You are a helpful assistant. Answer concisely.";
      const sideMessages: LlmMessage[] = [{ role: "user", content: question }];
      process.stderr.write(`${DIM}── side conversation ──${RESET}\n`);
      ctx.provider.chat(sideSystemPrompt, sideMessages, []).then((response) => {
        const text = typeof response.content === "string"
          ? response.content
          : response.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("");
        process.stderr.write(`${DIM}${text}${RESET}\n`);
        process.stderr.write(`${DIM}── end side conversation ──${RESET}\n`);
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${RED}Side conversation error: ${msg}${RESET}\n`);
      });
      return true;
    }

    case "/spawn": {
      if (!ctx.spawner) {
        process.stderr.write(`${DIM}Spawner not available. Start with --multi or --team to enable.${RESET}\n`);
        return true;
      }
      const spawnName = parts[1];
      const spawnTask = parts.slice(2).join(" ");
      if (!spawnName || !spawnTask) {
        process.stderr.write(`${DIM}Usage: /spawn <name> <task>${RESET}\n`);
        return true;
      }
      const agentId = ctx.spawner.spawn({ task: spawnTask, cwd: process.cwd() });
      process.stderr.write(`${DIM}Spawned agent "${spawnName}" (${agentId}): ${spawnTask}${RESET}\n`);
      return true;
    }

    case "/agents": {
      if (!ctx.spawner) {
        process.stderr.write(`${DIM}No spawner available. Start with --multi or --team to enable.${RESET}\n`);
        return true;
      }
      const agents = ctx.spawner.listAgents();
      if (agents.length === 0) {
        process.stderr.write(`${DIM}No agents running.${RESET}\n`);
      } else {
        const lines = agents.map((a) => {
          const elapsed = a.finishedAt
            ? `${((a.finishedAt - a.startedAt) / 1000).toFixed(1)}s`
            : `${((Date.now() - a.startedAt) / 1000).toFixed(0)}s`;
          return `  ${a.id} [${a.status}] ${elapsed} — ${a.task.slice(0, 60)}`;
        });
        process.stderr.write(`${DIM}Agents (${agents.length}):\n${lines.join("\n")}${RESET}\n`);
      }
      return true;
    }

    case "/preset": {
      const sub = parts[1]?.toLowerCase();

      if (!sub || sub === "list") {
        const all = listPresets();
        if (all.length === 0) {
          process.stderr.write(`${DIM}No presets.${RESET}\n`);
        } else {
          const lines = all.map((p) => `  ${formatPreset(p.name, p.preset, p.builtin)}`);
          process.stderr.write(`${DIM}Presets:\n${lines.join("\n")}${RESET}\n`);
        }
        return true;
      }

      if (sub === "save") {
        // /preset save <name> [provider=X] [model=X] [permissions=X] [max-turns=N] [budget=N] [plan]
        const presetName = parts[2];
        if (!presetName) {
          process.stderr.write(`${DIM}Usage: /preset save <name> [provider=X] [model=X] [permissions=X] [max-turns=N] [budget=N] [plan]${RESET}\n`);
          return true;
        }
        const preset: Record<string, unknown> = {};
        for (const arg of parts.slice(3)) {
          const [k, v] = arg.split("=", 2);
          if (k === "provider") preset.provider = v;
          else if (k === "model") preset.model = v;
          else if (k === "permissions") preset.permissions = v;
          else if (k === "max-turns") preset.maxTurns = parseInt(v, 10) || undefined;
          else if (k === "budget") preset.budget = v === "none" ? null : parseFloat(v) || undefined;
          else if (k === "plan") preset.plan = true;
        }
        try {
          savePreset(presetName, preset as import("./multi/presets.js").Preset);
          process.stderr.write(`${DIM}Saved preset "${presetName}".${RESET}\n`);
        } catch (err: unknown) {
          process.stderr.write(`${DIM}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
        }
        return true;
      }

      if (sub === "delete") {
        const presetName = parts[2];
        if (!presetName) {
          process.stderr.write(`${DIM}Usage: /preset delete <name>${RESET}\n`);
          return true;
        }
        try {
          const ok = deletePreset(presetName);
          process.stderr.write(`${DIM}${ok ? `Deleted "${presetName}".` : `Preset "${presetName}" not found.`}${RESET}\n`);
        } catch (err: unknown) {
          process.stderr.write(`${DIM}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
        }
        return true;
      }

      // /preset <name> — show preset details (use --preset <name> on CLI to apply at startup)
      const preset = loadPreset(sub);
      if (!preset) {
        process.stderr.write(`${DIM}Preset "${sub}" not found. Use /preset list to see available presets.${RESET}\n`);
      } else {
        const isBuiltin = ["fast", "careful", "yolo"].includes(sub);
        process.stderr.write(`${DIM}${formatPreset(sub, preset, isBuiltin)}\nUse: phren-agent --preset ${sub} <task>${RESET}\n`);
      }
      return true;
    }

    case "/effort": {
      const level = parts[1]?.toLowerCase();
      const VALID_LEVELS = ["low", "medium", "high", "max"];
      if (!level || !VALID_LEVELS.includes(level)) {
        process.stderr.write(`${DIM}Usage: /effort <low|medium|high|max>${RESET}\n`);
        process.stderr.write(`${DIM}  low    — Quick answers, minimal reasoning${RESET}\n`);
        process.stderr.write(`${DIM}  medium — Balanced depth and speed${RESET}\n`);
        process.stderr.write(`${DIM}  high   — Deep reasoning, thorough exploration${RESET}\n`);
        process.stderr.write(`${DIM}  max    — Maximum reasoning depth${RESET}\n`);
      } else {
        process.stderr.write(`${GREEN}Effort: ${level}${RESET}\n`);
      }
      return true;
    }

    case "/exit":
    case "/quit":
    case "/q":
      process.exit(0);

    default:
      if (input.startsWith("/")) {
        process.stderr.write(`${DIM}Unknown command: ${name}. Type /help for commands.${RESET}\n`);
        return true;
      }
      return false;
  }
}
