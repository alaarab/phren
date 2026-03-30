/**
 * Terminal UI for phren-agent — streaming chat with inline tool calls.
 * Dual-mode: Chat (LLM conversation) and Menu (navigable memory browser).
 * Tab toggles between modes. Raw stdin for steering support.
 */
import * as readline from "node:readline";
import type { AgentConfig } from "./agent-loop.js";
import { createSession, runTurn, type AgentSession, type TurnHooks } from "./agent-loop.js";
import { handleCommand } from "./commands.js";
import type { InputMode } from "./repl.js";
import type { AgentSpawner } from "./multi/spawner.js";
import { renderMarkdown } from "./multi/markdown.js";
import { decodeDiffPayload, renderInlineDiff, DIFF_MARKER } from "./multi/diff-renderer.js";
import * as os from "os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { loadInputMode, saveInputMode, savePermissionMode } from "./settings.js";
import { createRequire } from "node:module";

import {
  ESC, s, cols, stripAnsi,
  PERMISSION_COLORS, PERMISSION_ICONS, PERMISSION_LABELS,
  nextPermissionMode, permTag,
  formatToolInput, renderToolCall,
} from "./tui/index.js";
import {
  loadMenuModule, renderMenu as renderMenuFrame,
  enterMenuMode as enterMenu, exitMenuMode as exitMenu,
  handleMenuKeypress as handleMenuKey,
} from "./tui/index.js";
import type { MenuState, MenuContext } from "./tui/index.js";

const _require = createRequire(import.meta.url);
const AGENT_VERSION = (_require("../package.json") as { version: string }).version;

type TuiMode = "chat" | "menu";

// ── Status bar ───────────────────────────────────────────────────────────────
function renderStatusBar(provider: string, project: string | null, turns: number, cost: string, permMode?: import("./permissions/types.js").PermissionMode, agentCount?: number): string {
  const modeLabel = permMode ? PERMISSION_LABELS[permMode] : "";
  const agentTag = agentCount && agentCount > 0 ? ` A${agentCount}` : "";

  // Left: brand + provider (skip project if it matches "phren" to avoid "phren · codex · phren")
  const parts = [" ◆ phren", provider];
  if (project && project !== "phren") parts.push(project);
  const left = parts.join(" · ");

  // Right: mode + agents + cost + turns
  const rightParts: string[] = [];
  if (modeLabel) rightParts.push(modeLabel);
  if (agentTag) rightParts.push(agentTag.trim());
  if (cost) rightParts.push(cost);
  rightParts.push(`T${turns}`);
  const right = rightParts.join("  ") + " ";

  const w = cols();
  const pad = Math.max(0, w - left.length - right.length);
  return s.invert(left + " ".repeat(pad) + right);
}

// ── Main TUI ─────────────────────────────────────────────────────────────────
export async function startTui(config: AgentConfig, spawner?: AgentSpawner): Promise<AgentSession> {
  const contextLimit = config.provider.contextWindow ?? 200_000;
  const session = createSession(contextLimit);
  const w = process.stdout;
  const isTTY = process.stdout.isTTY;
  const startTime = Date.now();

  let inputMode: InputMode = loadInputMode();
  let pendingInput: string | null = null;
  const steerQueue: string[] = [];
  let running = false;
  let inputLine = "";
  let cursorPos = 0;
  let costStr = "";

  // ── Dual-mode state ─────────────────────────────────────────────────────
  let tuiMode: TuiMode = "chat";
  let menuState: MenuState = {
    view: "Projects",
    project: config.phrenCtx?.project ?? undefined,
    cursor: 0,
    scroll: 0,
  };
  let menuListCount = 0;
  let menuFilterActive = false;
  let menuFilterBuf = "";
  let ctrlCCount = 0;

  // Input history
  const inputHistory: string[] = [];
  let historyIndex = -1;
  let savedInput = "";

  // ── Menu context bridge ─────────────────────────────────────────────────
  function getMenuCtx(): MenuContext {
    return {
      phrenCtx: config.phrenCtx ? {
        phrenPath: config.phrenCtx.phrenPath,
        profile: config.phrenCtx.profile,
        project: config.phrenCtx.project ?? undefined,
      } : undefined,
      w,
      menuState,
      menuListCount,
      menuFilterActive,
      menuFilterBuf,
      onExit: () => {
        tuiMode = "chat";
        statusBar();
        prompt();
      },
      onStateChange: (st, lc, fa, fb) => {
        menuState = st;
        menuListCount = lc;
        menuFilterActive = fa;
        menuFilterBuf = fb;
      },
    };
  }

  // Print status bar
  function statusBar() {
    // Intentionally empty — no top status bar. Info is in the bottom prompt area.
  }

  // Print prompt — inline input bar (written at current cursor position)
  let bashMode = false;
  // Track how many lines the bottom bar occupies so we can clear it on submit
  const PROMPT_LINES = 4; // separator, input, separator, permissions

  function prompt() {
    if (!isTTY) return;
    const mode = config.registry.permissionConfig.mode;
    const color = PERMISSION_COLORS[mode];
    const icon = PERMISSION_ICONS[mode];
    const c = cols();
    const sep = s.dim("─".repeat(c));
    const permLine = `  ${color(`${icon} ${PERMISSION_LABELS[mode]} permissions`)} ${s.dim("(shift+tab toggle · esc to interrupt)")}`;
    // Write inline — this naturally sits at the bottom
    w.write(`${sep}\n`);
    w.write(`${bashMode ? `${s.yellow("!")} ` : `${s.dim("▸")} `}`);
    w.write(`\n${sep}\n`);
    w.write(`${permLine}\n`);
    // Move cursor back up to the input line
    w.write(`${ESC}${PROMPT_LINES - 1}A`); // move up to input line
    w.write(`${ESC}${bashMode ? 3 : 4}G`); // move to column after prompt char
  }

  // Redraw the input line and position the terminal cursor at cursorPos
  function redrawInput() {
    w.write(`${ESC}2K\r`);
    w.write(`${bashMode ? `${s.yellow("!")} ` : `${s.dim("▸")} `}`);
    w.write(inputLine);
    // Move terminal cursor back from end to cursorPos
    const back = inputLine.length - cursorPos;
    if (back > 0) w.write(`${ESC}${back}D`);
  }

  // Periodic status bar refresh (every 30s) — keeps cost/turns current during long tool runs
  const statusRefreshTimer = isTTY
    ? setInterval(() => { if (tuiMode === "chat") statusBar(); }, 30_000)
    : null;
  if (statusRefreshTimer) statusRefreshTimer.unref(); // don't keep process alive

  // Terminal cleanup: restore state on exit
  function cleanupTerminal() {
    if (statusRefreshTimer) clearInterval(statusRefreshTimer);
    w.write("\x1b[?1049l"); // leave alt screen if active
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
  }
  process.on("exit", cleanupTerminal);

  // Terminal resize: do nothing — scrollback text reflows naturally.
  // The Ink TUI handles resize via React re-render. Legacy TUI just lets it be.

  // Setup: clear screen, status bar at top, content area clean
  if (isTTY) {
    w.write(`${ESC}2J${ESC}H`); // clear entire screen + home
    statusBar();
    w.write(`${ESC}2;1H`); // move below status bar

    // Startup banner
    const project = config.phrenCtx?.project;
    const cwd = process.cwd().replace(os.homedir(), "~");
    const permMode = config.registry.permissionConfig.mode;

    let artLines: string[] = [];
    try {
      const { PHREN_ART } = await import("@phren/cli/phren-art" as string);
      artLines = (PHREN_ART as string[]).filter((l: string) => l.trim());
    } catch { /* art not available */ }

    const info = [
      `${s.brand("◆ phren agent")}  ${s.dim(`v${AGENT_VERSION}`)}`,
      `${s.dim(config.provider.name)}${project ? s.dim(` · ${project}`) : ""}`,
      `${s.dim(cwd)}`,
      ``,
      `${permTag(permMode)} ${s.dim("permissions (shift+tab toggle · esc to interrupt)")}`,
      ``,
      `${s.dim("Tab")} memory  ${s.dim("Shift+Tab")} perms  ${s.dim("/help")} cmds  ${s.dim("Ctrl+D")} exit`,
    ];

    if (artLines.length > 0) {
      const maxArtWidth = 26;
      for (let i = 0; i < Math.max(artLines.length, info.length); i++) {
        const artPart = i < artLines.length ? artLines[i] : "";
        const infoPart = i < info.length ? info[i] : "";
        const artPadded = artPart + " ".repeat(Math.max(0, maxArtWidth - stripAnsi(artPart).length));
        w.write(`${artPadded}${infoPart}\n`);
      }
    } else {
      w.write(`\n  ${info[0]}\n  ${info[1]}  ${info[2]}\n  ${info[4]}\n\n  ${info[6]}\n\n`);
    }
    w.write("\n");
  }

  // Raw stdin for steering
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  }

  let resolve: ((session: AgentSession) => void) | null = null;
  const done = new Promise<AgentSession>((r) => { resolve = r; });

  // ── Keypress router ────────────────────────────────────────────────────
  process.stdin.on("keypress", (_ch, key) => {
    if (!key) return;

    // Ctrl+D — clean exit
    if (key.ctrl && key.name === "d") {
      if (tuiMode === "menu") w.write("\x1b[?1049l");
      cleanupTerminal();
      w.write(`\n${s.dim(`${session.turns} turns, ${session.toolCalls} tool calls.`)}\n`);
      resolve!(session);
      return;
    }

    // Shift+Tab — cycle permission mode (works in chat mode, not during filter)
    if (key.shift && key.name === "tab" && !menuFilterActive && tuiMode === "chat") {
      const next = nextPermissionMode(config.registry.permissionConfig.mode);
      config.registry.setPermissions({ ...config.registry.permissionConfig, mode: next });
      savePermissionMode(next);
      // Redraw the entire prompt bar in-place (permissions line changed)
      w.write(`\r${ESC}J`); // clear from cursor to end of screen
      prompt();
      w.write(inputLine);
      const back = inputLine.length - cursorPos;
      if (back > 0) w.write(`${ESC}${back}D`);
      return;
    }

    // Tab — completion or toggle mode
    if (key.name === "tab" && !key.shift && !menuFilterActive) {
      // Slash command completion in chat mode
      if (tuiMode === "chat" && inputLine.startsWith("/")) {
        const SLASH_COMMANDS = [
          "/help", "/model", "/provider", "/turns", "/clear", "/cost",
          "/plan", "/undo", "/history", "/compact", "/context", "/mode",
          "/spawn", "/agents", "/diff", "/git", "/files", "/cwd",
          "/preset", "/exit",
        ];
        const matches = SLASH_COMMANDS.filter((c) => c.startsWith(inputLine));
        if (matches.length === 1) {
          inputLine = matches[0];
          cursorPos = inputLine.length;
          redrawInput();
        } else if (matches.length > 1) {
          // Show matches above prompt, then redraw
          w.write(`\r${ESC}J`); // clear from cursor to end of screen
          w.write(`\n${s.dim("  " + matches.join("  "))}\n`);
          prompt();
          w.write(inputLine);
          const back = inputLine.length - cursorPos;
          if (back > 0) w.write(`${ESC}${back}D`);
        }
        return;
      }
      // File path completion in bash mode
      if (tuiMode === "chat" && bashMode && inputLine.length > 0) {
        // Complete the last whitespace-delimited token as a path
        const lastSpace = inputLine.lastIndexOf(" ");
        const prefix = lastSpace === -1 ? "" : inputLine.slice(0, lastSpace + 1);
        const partial = lastSpace === -1 ? inputLine : inputLine.slice(lastSpace + 1);
        const expandedPartial = partial.replace(/^~/, os.homedir());
        const dir = path.dirname(expandedPartial);
        const base = path.basename(expandedPartial);
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const matches = entries.filter((e) => e.name.startsWith(base));
          if (matches.length === 1) {
            const completed = matches[0];
            const fullPath = partial.startsWith("~")
              ? "~/" + path.relative(os.homedir(), path.join(dir, completed.name))
              : path.join(dir, completed.name);
            inputLine = prefix + fullPath + (completed.isDirectory() ? "/" : "");
            cursorPos = inputLine.length;
            redrawInput();
          } else if (matches.length > 1) {
            const names = matches.map((e) => e.name + (e.isDirectory() ? "/" : ""));
            w.write(`\r${ESC}J`); // clear from cursor to end of screen
            w.write(`\n${s.dim("  " + names.join("  "))}\n`);
            // Find longest common prefix for partial completion
            let common = matches[0].name;
            for (const m of matches) {
              while (!m.name.startsWith(common)) common = common.slice(0, -1);
            }
            if (common.length > base.length) {
              const fullPath = partial.startsWith("~")
                ? "~/" + path.relative(os.homedir(), path.join(dir, common))
                : path.join(dir, common);
              inputLine = prefix + fullPath;
              cursorPos = inputLine.length;
            }
            prompt();
            w.write(inputLine);
            const back = inputLine.length - cursorPos;
            if (back > 0) w.write(`${ESC}${back}D`);
          }
        } catch { /* dir doesn't exist or unreadable */ }
        return;
      }
      // Default: toggle menu mode
      if (tuiMode === "chat" && !running) {
        tuiMode = "menu";
        enterMenu(getMenuCtx());
      } else if (tuiMode === "menu") {
        exitMenu(getMenuCtx());
      }
      return;
    }

    // Route to mode-specific handler
    if (tuiMode === "menu") {
      handleMenuKey(key, getMenuCtx());
      return;
    }

    // ── Chat mode keys ──────────────────────────────────────────────────

    // Escape — exit bash mode, or clear input
    if (key.name === "escape") {
      if (bashMode) {
        bashMode = false;
        inputLine = "";
        cursorPos = 0;
        redrawInput();
        return;
      }
      if (inputLine) {
        inputLine = "";
        cursorPos = 0;
        redrawInput();
        return;
      }
    }

    // Ctrl+C — progressive: cancel → warn → quit
    if (key.ctrl && key.name === "c") {
      if (running) {
        // Cancel current agent turn
        pendingInput = null;
        w.write(s.yellow("\n  [interrupted]\n"));
        ctrlCCount = 0;
        return;
      }
      if (bashMode) {
        bashMode = false;
        inputLine = "";
        cursorPos = 0;
        redrawInput();
        ctrlCCount = 0;
        return;
      }
      if (inputLine) {
        // Clear input
        inputLine = "";
        cursorPos = 0;
        redrawInput();
        ctrlCCount = 0;
        return;
      }
      // Nothing to cancel — progressive quit
      ctrlCCount++;
      if (ctrlCCount === 1) {
        // Clear current prompt, print warning, redraw prompt
        w.write(`\r${ESC}J`);
        w.write(s.dim("\n  Press Ctrl+C again to exit.\n"));
        prompt();
        // Reset after 2 seconds
        setTimeout(() => { ctrlCCount = 0; }, 2000);
      } else {
        // Actually quit
        cleanupTerminal();
        w.write(s.dim("\nSession ended.\n"));
        resolve!(session);
      }
      return;
    }

    // Enter — submit
    if (key.name === "return") {
      const line = inputLine.trim();
      cursorPos = 0;
      inputLine = "";

      if (!line) { redrawInput(); return; }

      // Push to history
      if (inputHistory[inputHistory.length - 1] !== line) {
        inputHistory.push(line);
      }
      historyIndex = -1;

      // Bash mode: ! prefix runs shell directly
      if (line.startsWith("!") || bashMode) {
        const cmd = bashMode ? line : line.slice(1).trim();
        bashMode = false;
        if (cmd) {
          // Handle cd specially — change process cwd
          const cdMatch = cmd.match(/^cd\s+(.*)/);
          if (cdMatch) {
            try {
              const target = cdMatch[1].trim().replace(/^~/, os.homedir());
              const resolved = path.resolve(process.cwd(), target);
              process.chdir(resolved);
              w.write(s.dim(process.cwd()) + "\n");
            } catch (err: unknown) {
              w.write(s.red((err as Error).message) + "\n");
            }
          } else {
            try {
              const output = execSync(cmd, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
              w.write(output);
              if (!output.endsWith("\n")) w.write("\n");
            } catch (err: unknown) {
              const e = err as { stderr?: string; message?: string };
              w.write(s.red(e.stderr || e.message || "Command failed") + "\n");
            }
          }
        }
        prompt();
        return;
      }

      // Slash commands
      if (line === "/mode") {
        inputMode = inputMode === "steering" ? "queue" : "steering";
        saveInputMode(inputMode);
        w.write(s.yellow(`  Input mode: ${inputMode}\n`));
        prompt();
        return;
      }

      const cmdResult = handleCommand(line, {
        session,
        contextLimit,
        undoStack: [],
        providerName: config.provider.name,
        currentModel: (config.provider as { model?: string }).model,
        currentReasoning: config.provider.reasoningEffort ?? null,
        provider: config.provider,
        systemPrompt: config.systemPrompt,
        spawner,
        sessionId: config.sessionId,
        startTime,
        phrenPath: config.phrenCtx?.phrenPath,
        phrenCtx: config.phrenCtx,
        onModelChange: async (result) => {
          // Live model switch — re-resolve provider with new model
          try {
            const { resolveProvider } = await import("./providers/resolve.js") as typeof import("./providers/resolve.js");
            const newProvider = resolveProvider(config.provider.name, result.model, undefined, result.reasoning ?? undefined);
            config.provider = newProvider;
            // Rebuild system prompt with new model info
            const { buildSystemPrompt } = await import("./system-prompt.js") as typeof import("./system-prompt.js");
            config.systemPrompt = buildSystemPrompt(
              config.systemPrompt.split("\n## Last session")[0], // preserve context, strip old summary
              null,
              { name: newProvider.name, model: result.model },
            );
            statusBar();
          } catch { /* keep current provider on error */ }
        },
      });
      if (cmdResult === true) {
        prompt();
        return;
      }
      if (typeof cmdResult === "object" && cmdResult instanceof Promise) {
        cmdResult.then(() => { prompt(); });
        return;
      }

      // If agent is running, add to steer queue
      if (running) {
        if (inputMode === "steering") {
          steerQueue.push(line);
        } else {
          pendingInput = line;
        }
        // Show queued input above the thinking line
        w.write(`${ESC}2K${s.dim(`  ↳ ${inputMode === "steering" ? "steer" : "queued"}: ${line.slice(0, 60)}`)}\n`);
        return;
      }

      // Clear input line, echo user input above prompt, redraw prompt
      w.write(`\r${ESC}2K`); // clear input line
      // Scroll up: move to line above prompt area, write content, redraw prompt
      w.write(`${ESC}${PROMPT_LINES}A`); // move up past the prompt area
      w.write(`${s.bold("❯")} ${line}\n`);
      prompt(); // redraw prompt below
      runAgentTurn(line);
      return;
    }

    // Up arrow — previous history
    if (key.name === "up" && !running && tuiMode === "chat") {
      if (inputHistory.length === 0) return;
      if (historyIndex === -1) {
        savedInput = inputLine;
        historyIndex = inputHistory.length - 1;
      } else if (historyIndex > 0) {
        historyIndex--;
      }
      inputLine = inputHistory[historyIndex];
      cursorPos = inputLine.length;
      redrawInput();
      return;
    }

    // Down arrow — next history or restore saved
    if (key.name === "down" && !running && tuiMode === "chat") {
      if (historyIndex === -1) return;
      if (historyIndex < inputHistory.length - 1) {
        historyIndex++;
        inputLine = inputHistory[historyIndex];
      } else {
        historyIndex = -1;
        inputLine = savedInput;
      }
      cursorPos = inputLine.length;
      redrawInput();
      return;
    }

    // Ctrl+A — move cursor to start of line
    if (key.ctrl && key.name === "a") {
      cursorPos = 0;
      redrawInput();
      return;
    }

    // Ctrl+E — move cursor to end of line
    if (key.ctrl && key.name === "e") {
      cursorPos = inputLine.length;
      redrawInput();
      return;
    }

    // Ctrl+U — kill entire line
    if (key.ctrl && key.name === "u") {
      inputLine = "";
      cursorPos = 0;
      redrawInput();
      return;
    }

    // Ctrl+K — kill from cursor to end of line
    if (key.ctrl && key.name === "k") {
      inputLine = inputLine.slice(0, cursorPos);
      redrawInput();
      return;
    }

    // Left arrow — move cursor left one character
    if (key.name === "left" && !key.meta && !key.ctrl) {
      if (cursorPos > 0) {
        cursorPos--;
        w.write(`${ESC}D`);
      }
      return;
    }

    // Right arrow — move cursor right one character
    if (key.name === "right" && !key.meta && !key.ctrl) {
      if (cursorPos < inputLine.length) {
        cursorPos++;
        w.write(`${ESC}C`);
      }
      return;
    }

    // Alt+Left — move cursor left by one word
    if (key.name === "left" && (key.meta || key.ctrl)) {
      if (cursorPos > 0) {
        // Skip spaces, then skip non-spaces
        let p = cursorPos;
        while (p > 0 && inputLine[p - 1] === " ") p--;
        while (p > 0 && inputLine[p - 1] !== " ") p--;
        cursorPos = p;
        redrawInput();
      }
      return;
    }

    // Alt+Right — move cursor right by one word
    if (key.name === "right" && (key.meta || key.ctrl)) {
      if (cursorPos < inputLine.length) {
        let p = cursorPos;
        while (p < inputLine.length && inputLine[p] !== " ") p++;
        while (p < inputLine.length && inputLine[p] === " ") p++;
        cursorPos = p;
        redrawInput();
      }
      return;
    }

    // Word-delete: Alt+Backspace, Ctrl+Backspace, Ctrl+W
    if (
      ((key.meta || key.ctrl) && key.name === "backspace") ||
      (key.ctrl && key.name === "w")
    ) {
      if (cursorPos > 0) {
        // Find word boundary before cursor
        let p = cursorPos;
        while (p > 0 && inputLine[p - 1] === " ") p--;
        while (p > 0 && inputLine[p - 1] !== " ") p--;
        inputLine = inputLine.slice(0, p) + inputLine.slice(cursorPos);
        cursorPos = p;
        redrawInput();
      }
      return;
    }

    // Backspace — delete character before cursor
    if (key.name === "backspace") {
      if (cursorPos > 0) {
        inputLine = inputLine.slice(0, cursorPos - 1) + inputLine.slice(cursorPos);
        cursorPos--;
        redrawInput();
      }
      return;
    }

    // Delete — delete character at cursor
    if (key.name === "delete") {
      if (cursorPos < inputLine.length) {
        inputLine = inputLine.slice(0, cursorPos) + inputLine.slice(cursorPos + 1);
        redrawInput();
      }
      return;
    }

    // Regular character — insert at cursor position
    if (key.sequence && !key.ctrl && !key.meta) {
      // ! at start of empty input toggles bash mode
      if (key.sequence === "!" && inputLine === "" && !bashMode) {
        bashMode = true;
        redrawInput();
        return;
      }
      inputLine = inputLine.slice(0, cursorPos) + key.sequence + inputLine.slice(cursorPos);
      cursorPos += key.sequence.length;
      redrawInput();
    }
  });

  // TUI hooks — render streaming text with markdown, compact tool output
  let textBuffer = "";
  let firstDelta = true;
  let activeThinkTimer: ReturnType<typeof setInterval> | null = null;

  function flushTextBuffer() {
    if (!textBuffer) return;
    w.write(renderMarkdown(textBuffer));
    textBuffer = "";
  }

  const tuiHooks: TurnHooks = {
    onTextDelta: (text) => {
      if (firstDelta) {
        if (activeThinkTimer) { clearInterval(activeThinkTimer); activeThinkTimer = null; }
        w.write(`${ESC}2K\r`);
        w.write(`\n${s.brand("◆")} `); // blank line + diamond prefix for phren's response
        firstDelta = false;
      }
      w.write(text);
    },
    onTextDone: () => {
      flushTextBuffer();
    },
    onTextBlock: (text) => {
      if (activeThinkTimer) { clearInterval(activeThinkTimer); activeThinkTimer = null; }
      if (firstDelta) {
        w.write(`${ESC}2K\r`);
        w.write(`\n${s.brand("◆")} `); // diamond prefix + blank line before response
        firstDelta = false;
      }
      w.write(text);
      if (!text.endsWith("\n")) w.write("\n");
    },
    onToolStart: (name, input, count) => {
      // Kill the thinking animation if it's still running (tools can fire before any text delta)
      if (activeThinkTimer) { clearInterval(activeThinkTimer); activeThinkTimer = null; }
      if (firstDelta) {
        w.write(`${ESC}2K\r`); // clear thinking line
        firstDelta = false;
      }
      flushTextBuffer();
      const preview = formatToolInput(name, input);
      const countLabel = count > 1 ? s.dim(` (${count} tools)`) : "";
      w.write(`${ESC}2K  ${s.dim("◌")} ${s.gray(name)} ${s.dim(preview)}${countLabel}\r`);
    },
    onToolEnd: (name, input, output, isError, dur) => {
      w.write(`${ESC}2K\r`);
      const diffData = (name === "edit_file" || name === "write_file") ? decodeDiffPayload(output) : null;
      const cleanOutput = diffData ? output.slice(0, output.indexOf(DIFF_MARKER)) : output;
      w.write(renderToolCall(name, input, cleanOutput, isError, dur) + "\n");
      if (diffData) {
        w.write(renderInlineDiff(diffData.oldContent, diffData.newContent, diffData.filePath) + "\n");
      }
    },
    onStatus: (msg) => w.write(s.dim(msg)),
    getSteeringInput: () => {
      // Drain steer queue first (newest steering inputs)
      if (steerQueue.length > 0 && inputMode === "steering") {
        const steer = steerQueue.shift()!;
        w.write(s.yellow(`  ↳ steering: ${steer}\n`));
        return steer;
      }
      if (pendingInput && inputMode === "steering") {
        const steer = pendingInput;
        pendingInput = null;
        w.write(s.yellow(`  ↳ steering: ${steer}\n`));
        return steer;
      }
      return null;
    },
  };

  async function runAgentTurn(userInput: string) {
    running = true;
    firstDelta = true;
    const thinkStart = Date.now();
    // Phren thinking — subtle purple/cyan breath with rotating verbs
    const THINK_VERBS = ["thinking", "reasoning", "recalling", "connecting", "processing"];
    let thinkFrame = 0;
    activeThinkTimer = setInterval(() => {
      const elapsed = (Date.now() - thinkStart) / 1000;
      const verb = THINK_VERBS[Math.floor(elapsed / 6) % THINK_VERBS.length];
      const t = (Math.sin(thinkFrame * 0.08) + 1) / 2;
      const r = Math.round(155 * (1 - t) + 40 * t);
      const g = Math.round(140 * (1 - t) + 211 * t);
      const b = Math.round(250 * (1 - t) + 242 * t);
      const color = `${ESC}38;2;${r};${g};${b}m`;
      w.write(`${ESC}2K${color}◆ ${verb}${ESC}0m ${s.dim(`${elapsed.toFixed(1)}s`)}\r`);
      thinkFrame++;
    }, 50);

    try {
      await runTurn(userInput, session, config, tuiHooks);
      if (activeThinkTimer) { clearInterval(activeThinkTimer); activeThinkTimer = null; }
      const elapsed = ((Date.now() - thinkStart) / 1000).toFixed(1);
      const DONE_VERBS = ["◆ recalled", "◆ processed", "◆ connected", "◆ resolved"];
      const doneVerb = DONE_VERBS[session.turns % DONE_VERBS.length];
      w.write(`${ESC}2K${s.dim(`${doneVerb} in ${elapsed}s`)}\n\n`);
      statusBar();
    } catch (err: unknown) {
      if (activeThinkTimer) { clearInterval(activeThinkTimer); activeThinkTimer = null; }
      const msg = err instanceof Error ? err.message : String(err);
      w.write(`${ESC}2K\r`);
      w.write(s.red(`  Error: ${msg}\n`));
    }

    running = false;

    // Process queued input — steer queue first, then pending
    if (steerQueue.length > 0) {
      const queued = steerQueue.shift()!;
      w.write(`${s.bold("❯")} ${queued}\n`);
      runAgentTurn(queued);
    } else if (pendingInput) {
      const queued = pendingInput;
      pendingInput = null;
      w.write(`${s.bold("❯")} ${queued}\n`);
      runAgentTurn(queued);
    } else {
      prompt();
    }
  }

  // Initial prompt
  prompt();

  return done;
}
