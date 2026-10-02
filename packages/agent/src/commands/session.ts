import { toolResultText } from "../providers/types.js";
import type { LlmMessage } from "../providers/types.js";
import { SessionLog, seedFromMessages } from "../session/log.js";
import { listEventLogs, loadEventLog, type SessionListing } from "../session/persist.js";
import { agentUserDir } from "../config.js";
/**
 * Session commands: /session, /history, /compact, /diff, /git
 */
import type { CommandContext } from "../commands.js";
import { estimateMessageTokens } from "../context/token-counter.js";
import { planPrune } from "../context/pruner.js";
import { compactWithLlm } from "../context/compactor.js";
import { renderMarkdown } from "../multi/markdown.js";
import { saveSessionMessages, loadLastSessionSnapshot } from "../memory/session.js";
import { listCheckpoints, restoreCheckpoint } from "../checkpoint.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const HISTORY_MAX_LINES = 5;

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

export function sessionCommand(parts: string[], ctx: CommandContext): boolean {
  const sub = parts[1]?.toLowerCase();

  if (sub === "save") {
    if (!ctx.phrenPath || !ctx.sessionId) {
      process.stderr.write(`${DIM}No active phren session to save.${RESET}\n`);
      return true;
    }
    try {
      saveSessionMessages(ctx.phrenPath, ctx.sessionId, ctx.session.messages, ctx.phrenCtx?.project ?? undefined);
      process.stderr.write(`${GREEN}-> Checkpoint saved (${ctx.session.messages.length} messages)${RESET}\n`);
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
      process.stderr.write(`${GREEN}-> Exported to ${exportFile}${RESET}\n`);
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

export function historyCommand(parts: string[], ctx: CommandContext): boolean {
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
  process.stderr.write(`${DIM}-- History (${slice.length}/${msgs.length} messages, ~${tokens} tokens, ${pct}% context) --${RESET}\n`);

  for (const msg of slice) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        const truncated = truncateText(msg.content, isFull ? Infinity : HISTORY_MAX_LINES);
        process.stderr.write(`\n${CYAN}${BOLD}You:${RESET} ${truncated}\n`);
      } else {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            const icon = block.is_error ? `${RED}\u2717${RESET}` : `${GREEN}\u2713${RESET}`;
            const preview = toolResultText(block).slice(0, 80).replace(/\n/g, " ");
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
            process.stderr.write(`${YELLOW}  \u26A1 ${tb.name}${RESET}${DIM}(${inputPreview})${RESET}\n`);
          }
        }
      }
    }
  }

  process.stderr.write(`${DIM}-- end --${RESET}\n`);
  return true;
}

export async function compactCommand(parts: string[], ctx: CommandContext): Promise<boolean> {
  const focus = parts.slice(1).join(" ");
  const beforeCount = ctx.session.messages.length;
  const beforeTokens = estimateMessageTokens(ctx.session.messages);

  // LLM checkpoint when a provider is wired up; regex fallback otherwise.
  let applied = false;
  let mode = "regex";
  let routed = "";
  if (ctx.provider && ctx.systemPrompt) {
    const result = await compactWithLlm(ctx.provider, ctx.systemPrompt, ctx.session.messages, {
      phrenCtx: ctx.phrenCtx,
      sessionId: ctx.sessionId,
      pruneConfig: { contextLimit: ctx.contextLimit, keepRecentTurns: 4 },
      // Manual /compact should always try the LLM, even for small ranges.
      config: { minPrunedTokens: 0 },
      tools: ctx.registry?.getDefinitions?.(),
      focus,
    });
    if (result) {
      ctx.session.log.replaceMessageRange(result.plan.startIndex, result.plan.endIndex, result.plan.summaryMessage);
      applied = true;
      mode = result.usedLlm ? "llm" : "regex";
      if (result.promoted + result.queued > 0) {
        routed = `, ${result.promoted} finding(s) promoted, ${result.queued} queued for review`;
      }
    }
  } else {
    const plan = planPrune(ctx.session.messages, { contextLimit: ctx.contextLimit, keepRecentTurns: 4 });
    if (plan) {
      ctx.session.log.replaceMessageRange(plan.startIndex, plan.endIndex, plan.summaryMessage);
      applied = true;
    }
  }

  if (!applied) {
    process.stderr.write(`${DIM}Nothing to compact.${RESET}\n`);
    return true;
  }
  const afterCount = ctx.session.messages.length;
  const afterTokens = estimateMessageTokens(ctx.session.messages);
  const reduction = beforeTokens > 0 ? ((1 - afterTokens / beforeTokens) * 100).toFixed(0) : "0";
  const fmtBefore = beforeTokens >= 1000 ? `${(beforeTokens / 1000).toFixed(1)}k` : String(beforeTokens);
  const fmtAfter = afterTokens >= 1000 ? `${(afterTokens / 1000).toFixed(1)}k` : String(afterTokens);
  process.stderr.write(`${DIM}Compacted (${mode}): ${beforeCount} -> ${afterCount} messages (~${fmtBefore} -> ~${fmtAfter} tokens, ${reduction}% reduction${routed})${RESET}\n`);
  return true;
}

export function diffCommand(parts: string[], _ctx: CommandContext): boolean {
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

/** Sessions /resume can offer: this store's, or ~/.phren-agent's for this directory without one. */
function resumableSessions(ctx: CommandContext): SessionListing[] {
  const current = ctx.session.log.header.sessionId;
  const listed = ctx.phrenPath
    ? listEventLogs(ctx.phrenPath, { project: ctx.phrenCtx?.project ?? undefined, limit: 30 })
    : listEventLogs(agentUserDir(), { cwd: process.cwd(), limit: 30 });
  return listed.filter((s) => s.sessionId !== current);
}

function sessionLabel(s: SessionListing): { label: string; detail: string } {
  const when = new Date(s.mtimeMs).toISOString().replace("T", " ").slice(0, 16);
  return { label: s.title || "(no prompt)", detail: `${when} \u00b7 ${s.messages} msgs \u00b7 ${s.sessionId.slice(0, 8)}` };
}

/**
 * /resume picks an earlier session and loads its conversation into this
 * fresh one: from a picker in the terminal UI, by number or id prefix
 * (`/resume 2`, `/resume 3fa9`), or from a printed list elsewhere.
 */
export async function resumeCommand(parts: string[], ctx: CommandContext): Promise<boolean> {
  if (ctx.session.messages.length > 0) {
    process.stderr.write(`${DIM}Session already has history; /resume only works on a fresh session.${RESET}\n`);
    return true;
  }
  const sessions = resumableSessions(ctx);
  const arg = parts[1];
  let chosen: SessionListing | undefined;
  if (arg) {
    const index = Number(arg);
    chosen = Number.isInteger(index) && index >= 1 && index <= sessions.length
      ? sessions[index - 1]
      : sessions.find((s) => s.sessionId.startsWith(arg));
    if (!chosen) {
      process.stderr.write(`${RED}No session "${arg}". /resume lists them.${RESET}\n`);
      return true;
    }
  } else if (sessions.length === 0) {
    return resumeLegacySnapshot(ctx);
  } else if (ctx.pickFromList) {
    const picked = await ctx.pickFromList("Resume a session", sessions.map(sessionLabel));
    if (picked === null) return true;
    chosen = sessions[picked];
  } else {
    const lines = sessions.slice(0, 15).map((s, i) => {
      const { label, detail } = sessionLabel(s);
      return `  ${String(i + 1).padStart(2)}. ${label.slice(0, 60)}  ${detail}`;
    });
    process.stderr.write(`${DIM}Recent sessions (newest first):\n${lines.join("\n")}\n  /resume <n> or /resume <id> to load one${RESET}\n`);
    return true;
  }

  let messages: LlmMessage[];
  try {
    const { header, events } = loadEventLog(chosen.file);
    messages = SessionLog.restore(header, events, () => {}).getMessages();
  } catch (err: unknown) {
    process.stderr.write(`${RED}Cannot read that session: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    return true;
  }
  seedFromMessages(ctx.session.log, messages);
  process.stderr.write(`${GREEN}-> Resumed ${messages.length} messages from session ${chosen.sessionId.slice(0, 8)}: ${chosen.title}${RESET}\n`);
  process.stderr.write(`${DIM}   Use /history to review. The model sees the whole conversation on your next message.${RESET}\n`);
  return true;
}

/** Before event logs: the v1 snapshot saved at the end of the last session. */
function resumeLegacySnapshot(ctx: CommandContext): boolean {
  if (!ctx.phrenPath) {
    process.stderr.write(`${DIM}No previous session to resume.${RESET}\n`);
    return true;
  }
  const snapshot = loadLastSessionSnapshot(ctx.phrenPath, ctx.phrenCtx?.project ?? undefined);
  if (!snapshot || snapshot.messages.length === 0) {
    process.stderr.write(`${DIM}No previous session to resume.${RESET}\n`);
    return true;
  }
  seedFromMessages(ctx.session.log, snapshot.messages as unknown as LlmMessage[]);
  process.stderr.write(`${GREEN}-> Resumed ${snapshot.messages.length} messages from session ${snapshot.sessionId}${RESET}\n`);
  process.stderr.write(`${DIM}   Saved: ${snapshot.savedAt}. Use /history to review.${RESET}\n`);
  return true;
}

export function rewindCommand(parts: string[], _ctx: CommandContext): boolean {
  const arg = parts[1];
  const list = listCheckpoints();
  if (!arg) {
    if (list.length === 0) { process.stderr.write(`${DIM}No checkpoints.${RESET}\n`); return true; }
    const lines = list.map((c, i) => `  ${i + 1}. ${c.label}  ${c.createdAt.slice(0, 19).replace("T", " ")}`).join("\n");
    process.stderr.write(`${DIM}Checkpoints (newest first):\n${lines}\n  /rewind <n> to restore${RESET}\n`);
    return true;
  }
  const index = Number(arg);
  const target = Number.isInteger(index) && index >= 1 && index <= list.length
    ? list[index - 1]
    : list.find((c) => c.ref === arg || c.label === arg);
  if (!target) { process.stderr.write(`${RED}No checkpoint "${arg}".${RESET}\n`); return true; }
  const result = restoreCheckpoint(process.cwd(), target.ref);
  process.stderr.write(`${result.ok ? GREEN : RED}${result.message}${RESET}\n`);
  return true;
}

export function gitCommand(parts: string[], _ctx: CommandContext): boolean {
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
