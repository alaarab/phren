/**
 * Terminal UI for phren-agent — streaming chat with inline tool calls.
 * Raw stdin for steering support, ANSI rendering, status bar.
 */
import * as readline from "node:readline";
import type { AgentConfig } from "./agent-loop.js";
import { createSession, type AgentSession } from "./agent-loop.js";
import type { LlmMessage, ContentBlock, ToolUseBlock, StreamDelta } from "./providers/types.js";
import { handleCommand } from "./commands.js";
import { searchErrorRecovery } from "./memory/error-recovery.js";
import { shouldPrune, pruneMessages } from "./context/pruner.js";
import { withRetry } from "./providers/retry.js";
import type { InputMode } from "./repl.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const ESC = "\x1b[";
const s = {
  reset: `${ESC}0m`,
  bold: (t: string) => `${ESC}1m${t}${ESC}0m`,
  dim: (t: string) => `${ESC}2m${t}${ESC}0m`,
  cyan: (t: string) => `${ESC}36m${t}${ESC}0m`,
  green: (t: string) => `${ESC}32m${t}${ESC}0m`,
  yellow: (t: string) => `${ESC}33m${t}${ESC}0m`,
  red: (t: string) => `${ESC}31m${t}${ESC}0m`,
  gray: (t: string) => `${ESC}90m${t}${ESC}0m`,
  invert: (t: string) => `${ESC}7m${t}${ESC}0m`,
};

function cols(): number {
  return process.stdout.columns || 80;
}

// ── Status bar ───────────────────────────────────────────────────────────────
function renderStatusBar(provider: string, project: string | null, turns: number, cost: string): string {
  const left = ` ${s.bold("phren-agent")} ${s.dim("·")} ${provider}${project ? ` ${s.dim("·")} ${project}` : ""}`;
  const right = `${cost ? cost + " " : ""}${s.dim(`T${turns}`)} `;
  const w = cols();
  const pad = Math.max(0, w - stripAnsi(left).length - stripAnsi(right).length);
  return s.invert(stripAnsi(left) + " ".repeat(pad) + stripAnsi(right));
}

function stripAnsi(t: string): string {
  return t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// ── Tool call rendering ──────────────────────────────────────────────────────
function renderToolCall(name: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number): string {
  const inputPreview = JSON.stringify(input).slice(0, 80);
  const dur = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  const icon = isError ? s.red("✗") : s.green("✓");
  const header = s.dim(`  ${name}(${inputPreview})`) + `  ${icon} ${s.dim(dur)}`;

  // Show a few lines of output
  const lines = output.split("\n").slice(0, 6);
  const body = lines.map((l) => s.dim(`  │ ${l.slice(0, cols() - 6)}`)).join("\n");
  const more = output.split("\n").length > 6 ? s.dim(`  │ ... (${output.split("\n").length} lines)`) : "";

  return `${header}\n${body}${more ? "\n" + more : ""}`;
}

// ── Main TUI ─────────────────────────────────────────────────────────────────
export async function startTui(config: AgentConfig): Promise<AgentSession> {
  const contextLimit = config.provider.contextWindow ?? 200_000;
  const session = createSession(contextLimit);
  const w = process.stdout;
  const isTTY = process.stdout.isTTY;

  let inputMode: InputMode = loadInputMode();
  let pendingInput: string | null = null;
  let running = false;
  let inputLine = "";
  let costStr = "";

  // Print status bar
  function statusBar() {
    if (!isTTY) return;
    const bar = renderStatusBar(
      config.provider.name,
      config.phrenCtx?.project ?? null,
      session.turns,
      costStr,
    );
    w.write(`${ESC}s${ESC}H${bar}${ESC}u`); // save cursor, move to top, print, restore
  }

  // Print prompt
  function prompt() {
    const modeTag = inputMode === "steering" ? s.dim("[steer]") : s.dim("[queue]");
    w.write(`\n${s.cyan("phren>")} ${modeTag} `);
  }

  // Setup: alternate screen not needed — just reserve top line for status
  if (isTTY) {
    w.write("\n"); // make room for status bar
    w.write(`${ESC}1;1H`); // move to top
    statusBar();
    w.write(`${ESC}2;1H`); // move below status bar
    w.write(s.dim("phren-agent TUI. /help for commands, /mode to toggle steering/queue, Ctrl+D to exit.\n"));
  }

  // Raw stdin for steering
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  }

  let resolve: ((session: AgentSession) => void) | null = null;
  const done = new Promise<AgentSession>((r) => { resolve = r; });

  // Input buffer
  process.stdin.on("keypress", (_ch, key) => {
    if (!key) return;

    // Ctrl+D — exit
    if (key.ctrl && key.name === "d") {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      w.write(s.dim("\nSession ended.\n"));
      resolve!(session);
      return;
    }

    // Ctrl+C — cancel current or exit
    if (key.ctrl && key.name === "c") {
      if (running) {
        pendingInput = null; // cancel any pending
        w.write(s.yellow("\n  [interrupted]\n"));
      } else {
        inputLine = "";
        w.write("\n");
        prompt();
      }
      return;
    }

    // Enter — submit
    if (key.name === "return") {
      const line = inputLine.trim();
      inputLine = "";
      w.write("\n");

      if (!line) { prompt(); return; }

      // Slash commands
      if (line === "/mode") {
        inputMode = inputMode === "steering" ? "queue" : "steering";
        saveInputMode(inputMode);
        w.write(s.yellow(`  Input mode: ${inputMode}\n`));
        prompt();
        return;
      }

      if (handleCommand(line, { session, contextLimit, undoStack: [] })) {
        prompt();
        return;
      }

      // If agent is running, buffer input
      if (running) {
        pendingInput = line;
        const label = inputMode === "steering" ? "steering" : "queued";
        w.write(s.dim(`  ↳ ${label}: "${line.slice(0, 60)}"\n`));
        return;
      }

      // Run agent turn
      runAgentTurn(line);
      return;
    }

    // Backspace
    if (key.name === "backspace") {
      if (inputLine.length > 0) {
        inputLine = inputLine.slice(0, -1);
        w.write("\b \b");
      }
      return;
    }

    // Regular character
    if (key.sequence && !key.ctrl && !key.meta) {
      inputLine += key.sequence;
      w.write(key.sequence);
    }
  });

  async function runAgentTurn(userInput: string) {
    running = true;
    w.write(s.dim("  ⠋ Thinking...\r"));

    try {
      session.messages.push({ role: "user", content: userInput });

      // Prune if needed
      if (shouldPrune(config.systemPrompt, session.messages, { contextLimit })) {
        session.messages = pruneMessages(session.messages, { contextLimit, keepRecentTurns: 6 });
        w.write(s.dim("  [context pruned]\n"));
      }

      const toolDefs = config.registry.getDefinitions();
      const useStream = typeof config.provider.chatStream === "function";

      // Inner turn loop (tool calling continues until end_turn)
      let turnActive = true;
      while (turnActive) {
        let response;

        if (useStream) {
          // Streaming path
          const content: ContentBlock[] = [];
          let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
          let currentText = "";
          let activeToolId = "";
          let activeToolName = "";
          let activeToolJson = "";

          w.write(`${ESC}2K\r`); // clear "Thinking..." line

          const stream = config.provider.chatStream!(config.systemPrompt, session.messages, toolDefs);
          for await (const delta of stream) {
            if (delta.type === "text_delta") {
              w.write(delta.text);
              currentText += delta.text;
            } else if (delta.type === "tool_use_start") {
              if (currentText) { content.push({ type: "text", text: currentText }); currentText = ""; }
              activeToolId = delta.id;
              activeToolName = delta.name;
              activeToolJson = "";
            } else if (delta.type === "tool_use_delta") {
              activeToolJson += delta.json;
            } else if (delta.type === "tool_use_end") {
              let input: Record<string, unknown> = {};
              try { input = JSON.parse(activeToolJson); } catch {}
              content.push({ type: "tool_use", id: activeToolId, name: activeToolName, input });
            } else if (delta.type === "done") {
              stopReason = delta.stop_reason;
            }
          }
          if (currentText) { content.push({ type: "text", text: currentText }); }
          if (currentText) w.write("\n");

          response = { content, stop_reason: stopReason };
        } else {
          // Non-streaming fallback
          response = await withRetry(
            () => config.provider.chat(config.systemPrompt, session.messages, toolDefs),
            undefined,
            config.verbose,
          );
          w.write(`${ESC}2K\r`); // clear "Thinking..."
          for (const block of response.content) {
            if (block.type === "text" && block.text) {
              w.write(block.text);
              if (!block.text.endsWith("\n")) w.write("\n");
            }
          }
        }

        session.messages.push({ role: "assistant", content: response.content });
        session.turns++;

        if (response.stop_reason !== "tool_use") {
          turnActive = false;
          break;
        }

        // Execute tool calls
        const toolBlocks = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        const toolResults: ContentBlock[] = [];

        for (const block of toolBlocks) {
          session.toolCalls++;
          const start = Date.now();
          w.write(s.dim(`  ⠋ ${block.name}...\r`));

          const result = await config.registry.execute(block.name, block.input);
          const dur = Date.now() - start;

          // Error recovery
          if (result.is_error && config.phrenCtx) {
            try {
              const recovery = await searchErrorRecovery(config.phrenCtx, result.output);
              if (recovery) result.output += recovery;
            } catch {}
          }

          w.write(`${ESC}2K\r`); // clear spinner
          w.write(renderToolCall(block.name, block.input, result.output, !!result.is_error, dur) + "\n");

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.output,
            is_error: result.is_error,
          });
        }

        session.messages.push({ role: "user", content: toolResults });

        // Check for pending steering input
        if (pendingInput && inputMode === "steering") {
          const steer = pendingInput;
          pendingInput = null;
          w.write(s.yellow(`  ↳ steering: ${steer}\n`));
          session.messages.push({ role: "user", content: steer });
        }
      }

      statusBar();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      w.write(s.red(`  Error: ${msg}\n`));
    }

    running = false;

    // Process queued input
    if (pendingInput) {
      const queued = pendingInput;
      pendingInput = null;
      runAgentTurn(queued);
    } else {
      prompt();
    }
  }

  // Initial prompt
  prompt();

  return done;
}

// ── Settings persistence ─────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(os.homedir(), ".phren-agent", "settings.json");

function loadInputMode(): InputMode {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    if (data.inputMode === "queue") return "queue";
  } catch {}
  return "steering";
}

function saveInputMode(mode: InputMode): void {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")); } catch {}
    data.inputMode = mode;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch {}
}
