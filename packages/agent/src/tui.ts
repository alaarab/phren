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
import type { PermissionMode } from "./permissions/types.js";
import type { AgentSpawner } from "./multi/spawner.js";
import { renderMarkdown } from "./multi/markdown.js";
import { decodeDiffPayload, renderInlineDiff, DIFF_MARKER } from "./multi/diff-renderer.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

type TuiMode = "chat" | "menu";

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

// ── Permission mode helpers ─────────────────────────────────────────────────
const PERMISSION_MODES: PermissionMode[] = ["suggest", "auto-confirm", "full-auto"];

function nextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODES.indexOf(current);
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
}

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  "suggest": "suggest",
  "auto-confirm": "auto",
  "full-auto": "full-auto",
};

function formatPermissionMode(mode: PermissionMode): string {
  const label = PERMISSION_LABELS[mode];
  switch (mode) {
    case "suggest": return s.cyan(`[${label}]`);
    case "auto-confirm": return s.green(`[${label}]`);
    case "full-auto": return s.yellow(`[${label}]`);
  }
}

// ── Status bar ───────────────────────────────────────────────────────────────
function renderStatusBar(provider: string, project: string | null, turns: number, cost: string, permMode?: PermissionMode, agentCount?: number): string {
  const modeStr = permMode ? ` ${PERMISSION_LABELS[permMode]}` : "";
  const agentTag = agentCount && agentCount > 0 ? ` ${s.dim(`A${agentCount}`)}` : "";
  const left = ` ${s.bold("phren-agent")} ${s.dim("·")} ${provider}${project ? ` ${s.dim("·")} ${project}` : ""}`;
  const right = `${modeStr}${agentTag} ${cost ? cost + " " : ""}${s.dim(`T${turns}`)} `;
  const w = cols();
  const pad = Math.max(0, w - stripAnsi(left).length - stripAnsi(right).length);
  return s.invert(stripAnsi(left) + " ".repeat(pad) + stripAnsi(right));
}

function stripAnsi(t: string): string {
  return t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// ── Tool call rendering ──────────────────────────────────────────────────────
const COMPACT_LINES = 3;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function renderToolCall(name: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number): string {
  const inputPreview = JSON.stringify(input).slice(0, 80);
  const dur = formatDuration(durationMs);
  const icon = isError ? s.red("✗") : s.green("✓");
  const header = s.dim(`  ${name}(${inputPreview})`) + `  ${icon} ${s.dim(dur)}`;

  // Compact: show first 3 lines only, with overflow count
  const allLines = output.split("\n").filter(Boolean);
  const shown = allLines.slice(0, COMPACT_LINES);
  const body = shown.map((l) => s.dim(`  │ ${l.slice(0, cols() - 6)}`)).join("\n");
  const overflow = allLines.length - COMPACT_LINES;
  const more = overflow > 0 ? `\n${s.dim(`  │ [+${overflow} lines]`)}` : "";

  return `${header}\n${body}${more}`;
}

// ── Menu mode helpers ────────────────────────────────────────────────────────
let menuMod: typeof import("@phren/cli/shell/render-api") | null = null;
async function loadMenuModule() {
  if (!menuMod) {
    try { menuMod = await import("@phren/cli/shell/render-api"); } catch { menuMod = null; }
  }
  return menuMod;
}

// ── Main TUI ─────────────────────────────────────────────────────────────────
export async function startTui(config: AgentConfig, spawner?: AgentSpawner): Promise<AgentSession> {
  const contextLimit = config.provider.contextWindow ?? 200_000;
  const session = createSession(contextLimit);
  const w = process.stdout;
  const isTTY = process.stdout.isTTY;

  let inputMode: InputMode = loadInputMode();
  let pendingInput: string | null = null;
  let running = false;
  let inputLine = "";
  let costStr = "";

  // ── Dual-mode state ─────────────────────────────────────────────────────
  let tuiMode: TuiMode = "chat";
  type MenuState = import("@phren/cli/shell/render-api").MenuState;
  let menuState: MenuState = {
    view: "Projects",
    project: config.phrenCtx?.project ?? undefined,
    cursor: 0,
    scroll: 0,
  };
  let menuListCount = 0;
  let menuFilterActive = false;
  let menuFilterBuf = "";

  // ── Menu rendering ─────────────────────────────────────────────────────
  async function renderMenu() {
    const mod = await loadMenuModule();
    if (!mod || !config.phrenCtx) return;
    const result = await mod.renderMenuFrame(
      config.phrenCtx.phrenPath,
      config.phrenCtx.profile,
      menuState,
    );
    menuListCount = result.listCount;
    // Full-screen write: single write to avoid flicker
    w.write(`${ESC}?25l${ESC}H${ESC}2J${result.output}${ESC}?25h`);
  }

  function enterMenuMode() {
    if (!config.phrenCtx) {
      w.write(s.yellow("  phren not configured — menu unavailable\n"));
      return;
    }
    tuiMode = "menu";
    menuState.project = config.phrenCtx.project ?? menuState.project;
    w.write("\x1b[?1049h"); // enter alternate screen
    renderMenu();
  }

  function exitMenuMode() {
    tuiMode = "chat";
    menuFilterActive = false;
    menuFilterBuf = "";
    w.write("\x1b[?1049l"); // leave alternate screen (restores chat)
    statusBar();
    prompt();
  }

  // Print status bar
  function statusBar() {
    if (!isTTY) return;
    const bar = renderStatusBar(
      config.provider.name,
      config.phrenCtx?.project ?? null,
      session.turns,
      costStr,
      config.registry.permissionConfig.mode,
      spawner?.listAgents().length,
    );
    w.write(`${ESC}s${ESC}H${bar}${ESC}u`); // save cursor, move to top, print, restore
  }

  // Print prompt
  function prompt() {
    const modeTag = inputMode === "steering" ? s.dim("[steer]") : s.dim("[queue]");
    w.write(`\n${s.cyan("phren>")} ${modeTag} `);
  }

  // Terminal cleanup: restore state on exit
  function cleanupTerminal() {
    w.write("\x1b[?1049l"); // leave alt screen if active
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
  }
  process.on("exit", cleanupTerminal);

  // Setup: alternate screen not needed — just reserve top line for status
  if (isTTY) {
    w.write("\n"); // make room for status bar
    w.write(`${ESC}1;1H`); // move to top
    statusBar();
    w.write(`${ESC}2;1H`); // move below status bar
    w.write(s.dim("phren-agent TUI. Tab: memory browser  Shift+Tab: permissions  /help: commands  Ctrl+D: exit\n"));
  }

  // Raw stdin for steering
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  }

  let resolve: ((session: AgentSession) => void) | null = null;
  const done = new Promise<AgentSession>((r) => { resolve = r; });

  // ── Menu keypress handler ───────────────────────────────────────────────
  async function handleMenuKeypress(key: readline.Key) {
    // Filter input mode: capture text for / search
    if (menuFilterActive) {
      if (key.name === "escape") {
        menuFilterActive = false;
        menuFilterBuf = "";
        menuState = { ...menuState, filter: undefined, cursor: 0, scroll: 0 };
        renderMenu();
        return;
      }
      if (key.name === "return") {
        menuFilterActive = false;
        menuState = { ...menuState, filter: menuFilterBuf || undefined, cursor: 0, scroll: 0 };
        menuFilterBuf = "";
        renderMenu();
        return;
      }
      if (key.name === "backspace") {
        menuFilterBuf = menuFilterBuf.slice(0, -1);
        menuState = { ...menuState, filter: menuFilterBuf || undefined, cursor: 0 };
        renderMenu();
        return;
      }
      if (key.sequence && !key.ctrl && !key.meta) {
        menuFilterBuf += key.sequence;
        menuState = { ...menuState, filter: menuFilterBuf, cursor: 0 };
        renderMenu();
      }
      return;
    }

    // "/" starts filter input
    if (key.sequence === "/") {
      menuFilterActive = true;
      menuFilterBuf = "";
      return;
    }

    const mod = await loadMenuModule();
    if (!mod) { exitMenuMode(); return; }

    const newState = mod.handleMenuKey(
      menuState,
      key.name ?? "",
      menuListCount,
      config.phrenCtx?.phrenPath,
      config.phrenCtx?.profile,
    );

    if (newState === null) {
      exitMenuMode();
    } else {
      menuState = newState;
      renderMenu();
    }
  }

  // ── Keypress router ────────────────────────────────────────────────────
  process.stdin.on("keypress", (_ch, key) => {
    if (!key) return;

    // Ctrl+D — always exit
    if (key.ctrl && key.name === "d") {
      if (tuiMode === "menu") w.write("\x1b[?1049l"); // leave alt screen
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      w.write(s.dim("\nSession ended.\n"));
      resolve!(session);
      return;
    }

    // Shift+Tab — cycle permission mode (works in chat mode, not during filter)
    if (key.shift && key.name === "tab" && !menuFilterActive && tuiMode === "chat") {
      const current = config.registry.permissionConfig.mode;
      const next = nextPermissionMode(current);
      config.registry.setPermissions({ ...config.registry.permissionConfig, mode: next });
      savePermissionMode(next);
      w.write(s.yellow(`  [mode: ${next}]\n`));
      statusBar();
      if (!running) prompt();
      return;
    }

    // Tab — toggle mode (not during agent run or filter)
    if (key.name === "tab" && !menuFilterActive) {
      if (tuiMode === "chat" && !running) {
        enterMenuMode();
      } else if (tuiMode === "menu") {
        exitMenuMode();
      }
      return;
    }

    // Route to mode-specific handler
    if (tuiMode === "menu") {
      handleMenuKeypress(key);
      return;
    }

    // ── Chat mode keys ──────────────────────────────────────────────────

    // Ctrl+C — cancel current or clear line
    if (key.ctrl && key.name === "c") {
      if (running) {
        pendingInput = null;
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

  // TUI hooks — render streaming text with markdown, compact tool output
  let textBuffer = "";

  function flushTextBuffer() {
    if (!textBuffer) return;
    w.write(renderMarkdown(textBuffer));
    textBuffer = "";
  }

  const tuiHooks: TurnHooks = {
    onTextDelta: (text) => {
      textBuffer += text;
      // Flush on paragraph boundaries (double newline) or single newline for streaming feel
      if (textBuffer.includes("\n\n") || textBuffer.endsWith("\n")) {
        flushTextBuffer();
      }
    },
    onTextDone: () => {
      flushTextBuffer();
    },
    onTextBlock: (text) => {
      w.write(renderMarkdown(text));
      if (!text.endsWith("\n")) w.write("\n");
    },
    onToolStart: (name, _input, _count) => {
      flushTextBuffer();
      w.write(s.dim(`  ⠋ ${name}...\r`));
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
    w.write(s.dim("  ⠋ Thinking...\r"));

    try {
      await runTurn(userInput, session, config, tuiHooks);
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

function savePermissionMode(mode: PermissionMode): void {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")); } catch {}
    data.permissionMode = mode;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch {}
}
