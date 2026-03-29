/**
 * Slash command dispatch for the REPL.
 */
import type { AgentSession } from "./agent-loop.js";
import type { LlmMessage, LlmProvider } from "./providers/types.js";
import { estimateMessageTokens } from "./context/token-counter.js";
import { pruneMessages } from "./context/pruner.js";
import type { AgentSpawner } from "./multi/spawner.js";
import { listPresets, loadPreset, savePreset, deletePreset, formatPreset } from "./multi/presets.js";
import { renderMarkdown } from "./multi/markdown.js";
import { showModelPicker, type PickerResult } from "./multi/model-picker.js";
import { formatProviderList, formatModelAddHelp, addCustomModel, removeCustomModel, type ReasoningLevel } from "./multi/provider-manager.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { saveSessionMessages } from "./memory/session.js";
import type { PhrenContext } from "./memory/context.js";
import { buildIndex } from "@phren/cli/shared";
import { searchKnowledgeRows, rankResults } from "@phren/cli/shared/retrieval";
import { readFindings } from "@phren/cli/data/access";
import { readTasks } from "@phren/cli/data/tasks";
import { addFinding } from "@phren/cli/core/finding";

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
  /** LLM provider for /ask side-channel queries */
  provider?: LlmProvider;
  /** System prompt for /ask queries */
  systemPrompt?: string;
  /** Session ID for /session commands */
  sessionId?: string | null;
  /** Session start time (epoch ms) */
  startTime?: number;
  /** Phren data directory for session save/export */
  phrenPath?: string | null;
  /** Full phren context for /mem commands */
  phrenCtx?: PhrenContext | null;
}

export function createCommandContext(session: AgentSession, contextLimit: number): CommandContext {
  return {
    session,
    contextLimit,
    undoStack: [],
  };
}

/** Format elapsed milliseconds as human-readable duration. */
function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
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
 * Returns a Promise<boolean> for async commands like /ask.
 */
export function handleCommand(input: string, ctx: CommandContext): boolean | Promise<boolean> {
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
  /clear      Clear conversation history and terminal screen
  /cwd        Show current working directory
  /files      Quick file tree (max depth 2, first 30 files)
  /cost       Show token usage and estimated cost
  /plan       Show conversation plan (tool calls so far)
  /undo       Undo last user message and response
  /history [n|full]  Show last N messages (default 10) with rich formatting
  /compact    Compact conversation to save context space
  /context    Show context window usage and provider info
  /mode       Toggle input mode (steering ↔ queue)
  /spawn <name> <task>  Spawn a background agent
  /agents     List running agents
  /session    Show session info (id, duration, stats)
  /session save  Save conversation checkpoint
  /session export  Export conversation as JSON
  /diff [--staged]  Show git diff with syntax highlighting
  /git <cmd>  Run common git commands (status, log, stash, stash pop)
  /ask <question>  Quick LLM query (no tools, not added to session)
  /mem search <query>  Search phren memory directly
  /mem findings [project]  Show recent findings
  /mem tasks [project]  Show tasks
  /mem add <finding>  Quick-add a finding
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
      process.stdout.write("\x1b[2J\x1b[H"); // clear terminal screen
      process.stderr.write(`${DIM}Conversation cleared.${RESET}\n`);
      return true;

    case "/cwd":
      process.stderr.write(`${DIM}${process.cwd()}${RESET}\n`);
      return true;

    case "/files": {
      try {
        const countRaw = execSync(
          "find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | wc -l",
          { encoding: "utf-8", timeout: 5_000, cwd: process.cwd() },
        ).trim();
        const total = parseInt(countRaw, 10) || 0;
        const listRaw = execSync(
          "find . -maxdepth 2 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | sort | head -30",
          { encoding: "utf-8", timeout: 5_000, cwd: process.cwd() },
        ).trim();
        if (!listRaw) {
          process.stderr.write(`${DIM}No files found.${RESET}\n`);
        } else {
          const lines = listRaw.split("\n");
          const label = total > lines.length ? `${total} files (showing first ${lines.length})` : `${total} files`;
          process.stderr.write(`${DIM}${label}\n${listRaw}${RESET}\n`);
        }
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string };
        process.stderr.write(`${RED}${e.stderr || e.message || "find failed"}${RESET}\n`);
      }
      return true;
    }

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
      const beforeCount = ctx.session.messages.length;
      const beforeTokens = estimateMessageTokens(ctx.session.messages);
      ctx.session.messages = pruneMessages(ctx.session.messages, { contextLimit: ctx.contextLimit, keepRecentTurns: 4 });
      const afterCount = ctx.session.messages.length;
      const afterTokens = estimateMessageTokens(ctx.session.messages);
      const reduction = beforeTokens > 0 ? ((1 - afterTokens / beforeTokens) * 100).toFixed(0) : "0";
      const fmtBefore = beforeTokens >= 1000 ? `${(beforeTokens / 1000).toFixed(1)}k` : String(beforeTokens);
      const fmtAfter = afterTokens >= 1000 ? `${(afterTokens / 1000).toFixed(1)}k` : String(afterTokens);
      process.stderr.write(`${DIM}Compacted: ${beforeCount} → ${afterCount} messages (~${fmtBefore} → ~${fmtAfter} tokens, ${reduction}% reduction)${RESET}\n`);
      return true;
    }

    case "/context": {
      const ctxTokens = estimateMessageTokens(ctx.session.messages);
      const ctxPct = ctx.contextLimit > 0 ? (ctxTokens / ctx.contextLimit) * 100 : 0;
      const ctxPctStr = ctxPct.toFixed(1);
      const ctxWindowK = ctx.contextLimit >= 1000 ? `${(ctx.contextLimit / 1000).toFixed(0)}k` : String(ctx.contextLimit);
      const ctxTokensStr = ctxTokens >= 1000 ? `~${(ctxTokens / 1000).toFixed(1)}k` : `~${ctxTokens}`;

      // Progress bar: 10 chars wide
      const filled = Math.round(ctxPct / 10);
      const bar = "█".repeat(Math.min(filled, 10)) + "░".repeat(Math.max(10 - filled, 0));
      const barColor = ctxPct > 80 ? RED : ctxPct > 50 ? YELLOW : GREEN;

      const providerLabel = ctx.providerName ?? "unknown";
      const modelLabel = ctx.currentModel ?? "default";

      process.stderr.write(
        `${DIM}  Messages: ${ctx.session.messages.length}\n` +
        `  Tokens: ${ctxTokensStr} / ${ctxWindowK} (${ctxPctStr}%)\n` +
        `  Provider: ${providerLabel} (${modelLabel})\n` +
        `  Context window: ${ctxWindowK}\n` +
        `  ${barColor}[${bar}]${RESET}${DIM} ${ctxPctStr}%${RESET}\n`
      );
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

    case "/session": {
      const sub = parts[1]?.toLowerCase();

      if (sub === "save") {
        if (!ctx.phrenPath || !ctx.sessionId) {
          process.stderr.write(`${DIM}No active phren session to save.${RESET}\n`);
          return true;
        }
        try {
          saveSessionMessages(ctx.phrenPath, ctx.sessionId, ctx.session.messages);
          process.stderr.write(`${GREEN}→ Checkpoint saved (${ctx.session.messages.length} messages)${RESET}\n`);
        } catch (err: unknown) {
          process.stderr.write(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
        }
        return true;
      }

      if (sub === "export") {
        const exportDir = path.join(os.homedir(), ".phren-agent", "exports");
        fs.mkdirSync(exportDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const exportFile = path.join(exportDir, `session-${ts}.json`);
        try {
          fs.writeFileSync(exportFile, JSON.stringify(ctx.session.messages, null, 2) + "\n");
          process.stderr.write(`${GREEN}→ Exported to ${exportFile}${RESET}\n`);
        } catch (err: unknown) {
          process.stderr.write(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
        }
        return true;
      }

      // Default: show session info
      const duration = ctx.startTime ? formatElapsed(Date.now() - ctx.startTime) : "unknown";
      const lines: string[] = [];
      if (ctx.sessionId) lines.push(`  Session:  ${ctx.sessionId}`);
      lines.push(`  Turns:    ${ctx.session.turns}`);
      lines.push(`  Tools:    ${ctx.session.toolCalls}`);
      lines.push(`  Messages: ${ctx.session.messages.length}`);
      lines.push(`  Duration: ${duration}`);

      // Read session state file for findings/tasks counters
      if (ctx.phrenPath && ctx.sessionId) {
        try {
          const stateFile = path.join(ctx.phrenPath, ".runtime", "sessions", `session-${ctx.sessionId}.json`);
          const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
          lines.push(`  Findings: ${state.findingsAdded ?? 0}`);
          lines.push(`  Tasks:    ${state.tasksCompleted ?? 0}`);
        } catch { /* session file may not exist */ }
      }

      process.stderr.write(`${DIM}${lines.join("\n")}${RESET}\n`);
      return true;
    }

    case "/diff": {
      const staged = parts.includes("--staged") || parts.includes("--cached");
      const cmd = staged ? "git diff --staged" : "git diff";
      try {
        const raw = execSync(cmd, { encoding: "utf-8", timeout: 10_000, cwd: process.cwd() });
        if (!raw.trim()) {
          process.stderr.write(`${DIM}No ${staged ? "staged " : ""}changes.${RESET}\n`);
        } else {
          const colored = raw.split("\n").map((line) => {
            if (line.startsWith("diff --git")) return `${BOLD}${line}${RESET}`;
            if (line.startsWith("@@")) return `${CYAN}${line}${RESET}`;
            if (line.startsWith("+")) return `${GREEN}${line}${RESET}`;
            if (line.startsWith("-")) return `${RED}${line}${RESET}`;
            return line;
          }).join("\n");
          process.stderr.write(colored + "\n");
        }
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string };
        process.stderr.write(`${RED}${e.stderr || e.message || "git diff failed"}${RESET}\n`);
      }
      return true;
    }

    case "/git": {
      const sub = parts.slice(1).join(" ").trim();
      if (!sub) {
        process.stderr.write(`${DIM}Usage: /git <status|log|stash|stash pop>${RESET}\n`);
        return true;
      }
      const allowed: Record<string, string> = {
        "status": "git status",
        "log": "git log --oneline -5",
        "stash": "git stash",
        "stash pop": "git stash pop",
      };
      const gitCmd = allowed[sub];
      if (!gitCmd) {
        process.stderr.write(`${DIM}Supported: /git status, /git log, /git stash, /git stash pop${RESET}\n`);
        return true;
      }
      try {
        const output = execSync(gitCmd, { encoding: "utf-8", timeout: 10_000, cwd: process.cwd() });
        if (output.trim()) process.stderr.write(output.endsWith("\n") ? output : output + "\n");
        else process.stderr.write(`${DIM}(no output)${RESET}\n`);
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string };
        process.stderr.write(`${RED}${e.stderr || e.message || "git command failed"}${RESET}\n`);
      }
      return true;
    }

    case "/mem": {
      const sub = parts[1]?.toLowerCase();
      if (!ctx.phrenCtx) {
        process.stderr.write(`${DIM}No phren context available.${RESET}\n`);
        return true;
      }
      const pCtx = ctx.phrenCtx;

      if (!sub || sub === "help") {
        process.stderr.write(`${DIM}Usage:
  /mem search <query>     Search phren memory
  /mem findings [project] Show recent findings
  /mem tasks [project]    Show tasks
  /mem add <finding>      Quick-add a finding${RESET}\n`);
        return true;
      }

      if (sub === "search") {
        const query = parts.slice(2).join(" ").trim();
        if (!query) {
          process.stderr.write(`${DIM}Usage: /mem search <query>${RESET}\n`);
          return true;
        }
        return (async () => {
          try {
            const db = await buildIndex(pCtx.phrenPath, pCtx.profile);
            const result = await searchKnowledgeRows(db, {
              query,
              maxResults: 10,
              filterProject: pCtx.project || null,
              filterType: null,
              phrenPath: pCtx.phrenPath,
            });
            const ranked = rankResults(result.rows ?? [], query, null, pCtx.project || null, pCtx.phrenPath, db);
            if (ranked.length === 0) {
              process.stderr.write(`${DIM}No results found.${RESET}\n`);
            } else {
              const lines = ranked.slice(0, 10).map((r: { project: string; filename: string; content?: string }, i: number) => {
                const snippet = r.content?.slice(0, 200) ?? "";
                return `  ${CYAN}${i + 1}.${RESET} ${DIM}[${r.project}/${r.filename}]${RESET} ${snippet}`;
              });
              process.stderr.write(lines.join("\n") + "\n");
            }
          } catch (err: unknown) {
            process.stderr.write(`${RED}Search failed: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
          }
          return true;
        })();
      }

      if (sub === "findings") {
        const project = parts[2] || pCtx.project;
        if (!project) {
          process.stderr.write(`${DIM}Usage: /mem findings <project>${RESET}\n`);
          return true;
        }
        const result = readFindings(pCtx.phrenPath, project);
        if (!result.ok) {
          process.stderr.write(`${RED}${result.error}${RESET}\n`);
          return true;
        }
        const items = result.data ?? [];
        if (items.length === 0) {
          process.stderr.write(`${DIM}No findings for ${project}.${RESET}\n`);
          return true;
        }
        const recent = items.slice(-15);
        const lines = recent.map((f: { id: string; date: string; text: string }) =>
          `  ${DIM}${f.date}${RESET} ${f.text.slice(0, 120)}${f.text.length > 120 ? "..." : ""}`
        );
        process.stderr.write(`${DIM}── Findings (${items.length} total, showing last ${recent.length}) ──${RESET}\n`);
        process.stderr.write(lines.join("\n") + "\n");
        return true;
      }

      if (sub === "tasks") {
        const project = parts[2] || pCtx.project;
        if (!project) {
          process.stderr.write(`${DIM}Usage: /mem tasks <project>${RESET}\n`);
          return true;
        }
        const result = readTasks(pCtx.phrenPath, project);
        if (!result.ok) {
          process.stderr.write(`${RED}${result.error}${RESET}\n`);
          return true;
        }
        const sections: string[] = [];
        for (const [section, items] of Object.entries(result.data!.items)) {
          if (section === "Done") continue;
          if (items.length === 0) continue;
          const lines = items.map((t: { checked: boolean; line: string }) => {
            const icon = t.checked ? `${GREEN}✓${RESET}` : `${DIM}○${RESET}`;
            return `  ${icon} ${t.line}`;
          });
          sections.push(`${BOLD}${section}${RESET}\n${lines.join("\n")}`);
        }
        if (sections.length === 0) {
          process.stderr.write(`${DIM}No active tasks for ${project}.${RESET}\n`);
        } else {
          process.stderr.write(sections.join("\n") + "\n");
        }
        return true;
      }

      if (sub === "add") {
        const finding = parts.slice(2).join(" ").trim();
        if (!finding) {
          process.stderr.write(`${DIM}Usage: /mem add <finding text>${RESET}\n`);
          return true;
        }
        const project = pCtx.project;
        if (!project) {
          process.stderr.write(`${DIM}No project context. Cannot add finding without a project.${RESET}\n`);
          return true;
        }
        const result = addFinding(pCtx.phrenPath, project, finding);
        if (result.ok) {
          process.stderr.write(`${GREEN}→ Finding saved to ${project}.${RESET}\n`);
        } else {
          process.stderr.write(`${RED}${result.message ?? "Failed to save finding."}${RESET}\n`);
        }
        return true;
      }

      process.stderr.write(`${DIM}Unknown /mem subcommand: ${sub}. Try /mem help${RESET}\n`);
      return true;
    }

    case "/ask": {
      const question = parts.slice(1).join(" ").trim();
      if (!question) {
        process.stderr.write(`${DIM}Usage: /ask <question>${RESET}\n`);
        return true;
      }
      if (!ctx.provider) {
        process.stderr.write(`${DIM}Provider not available for /ask.${RESET}\n`);
        return true;
      }
      const provider = ctx.provider;
      const sysPrompt = ctx.systemPrompt ?? "You are a helpful assistant.";
      return (async () => {
        process.stderr.write(`${DIM}◆ quick answer (no tools):${RESET}\n`);
        try {
          const response = await provider.chat(sysPrompt, [{ role: "user", content: question }], []);
          for (const block of response.content) {
            if (block.type === "text") {
              process.stderr.write(renderMarkdown(block.text) + "\n");
            }
          }
        } catch (err: unknown) {
          process.stderr.write(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
        }
        return true;
      })();
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
