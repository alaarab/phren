/**
 * Info commands: /help, /turns, /clear, /cwd, /files, /cost, /plan, /undo, /context
 */
import type { CommandContext } from "../commands.js";
import { estimateMessageTokens } from "../context/token-counter.js";
import { execSync } from "node:child_process";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export function helpCommand(_parts: string[], _ctx: CommandContext): boolean {
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
}

export function turnsCommand(_parts: string[], ctx: CommandContext): boolean {
  const tokens = estimateMessageTokens(ctx.session.messages);
  const pct = ctx.contextLimit > 0 ? ((tokens / ctx.contextLimit) * 100).toFixed(1) : "?";
  const costLine = ctx.costTracker ? `  Cost: $${ctx.costTracker.totalCost.toFixed(4)}` : "";
  process.stderr.write(
    `${DIM}Turns: ${ctx.session.turns}  Tool calls: ${ctx.session.toolCalls}  ` +
    `Messages: ${ctx.session.messages.length}  Tokens: ~${tokens} (${pct}%)${costLine}${RESET}\n`
  );
  return true;
}

export function clearCommand(_parts: string[], ctx: CommandContext): boolean {
  ctx.session.messages.length = 0;
  ctx.session.turns = 0;
  ctx.session.toolCalls = 0;
  ctx.undoStack.length = 0;
  process.stdout.write("\x1b[2J\x1b[H");
  process.stderr.write(`${DIM}Conversation cleared.${RESET}\n`);
  return true;
}

export function cwdCommand(_parts: string[], _ctx: CommandContext): boolean {
  process.stderr.write(`${DIM}${process.cwd()}${RESET}\n`);
  return true;
}

export function filesCommand(_parts: string[], _ctx: CommandContext): boolean {
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

export function costCommand(_parts: string[], ctx: CommandContext): boolean {
  const ct = ctx.costTracker;
  if (ct) {
    process.stderr.write(`${DIM}Tokens — input: ${ct.inputTokens}  output: ${ct.outputTokens}  est. cost: $${ct.totalCost.toFixed(4)}${RESET}\n`);
  } else {
    process.stderr.write(`${DIM}Cost tracking not available.${RESET}\n`);
  }
  return true;
}

export function planCommand(_parts: string[], ctx: CommandContext): boolean {
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

export function undoCommand(_parts: string[], ctx: CommandContext): boolean {
  if (ctx.session.messages.length < 2) {
    process.stderr.write(`${DIM}Nothing to undo.${RESET}\n`);
    return true;
  }
  let removed = 0;
  while (ctx.session.messages.length > 0) {
    const last = ctx.session.messages.pop();
    removed++;
    if (last?.role === "user" && typeof last.content === "string") break;
  }
  process.stderr.write(`${DIM}Undid ${removed} messages.${RESET}\n`);
  return true;
}

export function contextCommand(_parts: string[], ctx: CommandContext): boolean {
  const ctxTokens = estimateMessageTokens(ctx.session.messages);
  const ctxPct = ctx.contextLimit > 0 ? (ctxTokens / ctx.contextLimit) * 100 : 0;
  const ctxPctStr = ctxPct.toFixed(1);
  const ctxWindowK = ctx.contextLimit >= 1000 ? `${(ctx.contextLimit / 1000).toFixed(0)}k` : String(ctx.contextLimit);
  const ctxTokensStr = ctxTokens >= 1000 ? `~${(ctxTokens / 1000).toFixed(1)}k` : `~${ctxTokens}`;

  const filled = Math.round(ctxPct / 10);
  const bar = "\u2588".repeat(Math.min(filled, 10)) + "\u2591".repeat(Math.max(10 - filled, 0));
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
