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
import * as os from "os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { loadInputMode, saveInputMode, savePermissionMode } from "./settings.js";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const AGENT_VERSION = (_require("../package.json") as { version: string }).version;

type TuiMode = "chat" | "menu";

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const ESC = "\x1b[";
const s = {
  reset: `${ESC}0m`,
  bold: (t: string) => `${ESC}1m${t}${ESC}0m`,
  dim: (t: string) => `${ESC}2m${t}${ESC}0m`,
  italic: (t: string) => `${ESC}3m${t}${ESC}0m`,
  cyan: (t: string) => `${ESC}36m${t}${ESC}0m`,
  green: (t: string) => `${ESC}32m${t}${ESC}0m`,
  yellow: (t: string) => `${ESC}33m${t}${ESC}0m`,
  red: (t: string) => `${ESC}31m${t}${ESC}0m`,
  blue: (t: string) => `${ESC}34m${t}${ESC}0m`,
  magenta: (t: string) => `${ESC}35m${t}${ESC}0m`,
  gray: (t: string) => `${ESC}90m${t}${ESC}0m`,
  invert: (t: string) => `${ESC}7m${t}${ESC}0m`,
  // Gradient-style brand text
  brand: (t: string) => `${ESC}1;35m${t}${ESC}0m`,
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

const PERMISSION_ICONS: Record<PermissionMode, string> = {
  "suggest": "○",
  "auto-confirm": "◐",
  "full-auto": "●",
};

const PERMISSION_COLORS: Record<PermissionMode, (t: string) => string> = {
  "suggest": s.cyan,
  "auto-confirm": s.green,
  "full-auto": s.yellow,
};

function permTag(mode: PermissionMode): string {
  return PERMISSION_COLORS[mode](`${PERMISSION_ICONS[mode]} ${mode}`);
}

// ── Status bar ───────────────────────────────────────────────────────────────
function renderStatusBar(provider: string, project: string | null, turns: number, cost: string, permMode?: PermissionMode, agentCount?: number): string {
  const modeLabel = permMode ? PERMISSION_LABELS[permMode] : "";
  const agentTag = agentCount && agentCount > 0 ? ` A${agentCount}` : "";

  // Left: brand + provider + project
  const parts = [" ◆ phren", provider];
  if (project) parts.push(project);
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

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file": return input.file_path as string ?? "";
    case "shell": return (input.command as string ?? "").slice(0, 60);
    case "glob": return input.pattern as string ?? "";
    case "grep": return `/${input.pattern ?? ""}/ ${input.path ?? ""}`;
    case "git_commit": return (input.message as string ?? "").slice(0, 50);
    case "phren_search": return input.query as string ?? "";
    case "phren_add_finding": return (input.finding as string ?? "").slice(0, 50);
    default: return JSON.stringify(input).slice(0, 60);
  }
}

function renderToolCall(name: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number): string {
  const preview = formatToolInput(name, input);
  const dur = formatDuration(durationMs);
  const icon = isError ? s.red("✗") : s.green("→");
  const header = `  ${icon} ${s.bold(name)} ${s.gray(preview)}  ${s.dim(dur)}`;

  // Compact: show first 3 lines only, with overflow count
  const allLines = output.split("\n").filter(Boolean);
  if (allLines.length === 0) return header;
  const shown = allLines.slice(0, COMPACT_LINES);
  const body = shown.map((l) => s.dim(`    ${l.slice(0, cols() - 6)}`)).join("\n");
  const overflow = allLines.length - COMPACT_LINES;
  const more = overflow > 0 ? `\n${s.dim(`    ... +${overflow} lines`)}` : "";

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
  const startTime = Date.now();

  let inputMode: InputMode = loadInputMode();
  let pendingInput: string | null = null;
  let running = false;
  let inputLine = "";
  let cursorPos = 0;
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
  let ctrlCCount = 0;

  // Input history
  const inputHistory: string[] = [];
  let historyIndex = -1;
  let savedInput = "";

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
    setScrollRegion(); // re-establish scroll region after alt screen
    statusBar();
    prompt(true); // skip newline — alt screen restore already positioned cursor
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

  // Print prompt — bordered input bar at bottom
  let bashMode = false;

  function prompt(skipNewline = false) {
    if (!isTTY) return;
    const mode = config.registry.permissionConfig.mode;
    const color = PERMISSION_COLORS[mode];
    const icon = PERMISSION_ICONS[mode];
    const rows = process.stdout.rows || 24;
    const c = cols();
    if (!skipNewline) {
      // Newline within the scroll region so content scrolls up naturally
      cursorToScrollEnd();
      w.write("\n");
    }
    // Draw the fixed bottom bar outside the scroll region.
    // Temporarily reset DECSTBM so writes to rows (rows-4)..(rows) work.
    w.write(`${ESC}r`); // reset scroll region temporarily
    // Layout (bottom up): blank, permissions, separator, input, separator
    const sep = s.dim("─".repeat(c));
    const permLine = `  ${color(`${icon} ${PERMISSION_LABELS[mode]} permissions`)} ${s.dim("(shift+tab toggle · esc to interrupt)")}`;
    w.write(`${ESC}${rows - 4};1H${ESC}2K${sep}`);
    w.write(`${ESC}${rows - 3};1H${ESC}2K${bashMode ? `${s.yellow("!")} ` : `${s.dim("▸")} `}`);
    w.write(`${ESC}${rows - 2};1H${ESC}2K${sep}`);
    w.write(`${ESC}${rows - 1};1H${ESC}2K${permLine}`);
    w.write(`${ESC}${rows};1H${ESC}2K`); // blank bottom row
    // Re-establish scroll region and position cursor at the input line
    setScrollRegion();
    w.write(`${ESC}${rows - 3};${bashMode ? 3 : 4}H`);
  }

  // Redraw the input line and position the terminal cursor at cursorPos
  function redrawInput() {
    w.write(`${ESC}2K\r`);
    prompt(true);
    w.write(inputLine);
    // Move terminal cursor back from end to cursorPos
    const back = inputLine.length - cursorPos;
    if (back > 0) w.write(`${ESC}${back}D`);
  }

  // ── Scroll region management ─────────────────────────────────────────
  // DECSTBM: rows 1..(rows-5) scroll; bottom 5 rows are fixed for the input bar.
  function setScrollRegion() {
    if (!isTTY) return;
    const rows = process.stdout.rows || 24;
    const scrollBottom = Math.max(1, rows - 5);
    w.write(`${ESC}1;${scrollBottom}r`);
  }

  // Move cursor to the bottom of the scroll region so new output scrolls naturally.
  function cursorToScrollEnd() {
    if (!isTTY) return;
    const rows = process.stdout.rows || 24;
    const scrollBottom = Math.max(1, rows - 5);
    w.write(`${ESC}${scrollBottom};1H`);
  }

  // Periodic status bar refresh (every 30s) — keeps cost/turns current during long tool runs
  const statusRefreshTimer = isTTY
    ? setInterval(() => { if (tuiMode === "chat") statusBar(); }, 30_000)
    : null;
  if (statusRefreshTimer) statusRefreshTimer.unref(); // don't keep process alive

  // Terminal cleanup: restore state on exit
  function cleanupTerminal() {
    if (statusRefreshTimer) clearInterval(statusRefreshTimer);
    w.write(`${ESC}r`); // reset scroll region
    w.write("\x1b[?1049l"); // leave alt screen if active
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
  }
  process.on("exit", cleanupTerminal);

  // Re-establish scroll region on terminal resize.
  // Node's "resize" event already fires on SIGWINCH — no separate signal handler needed.
  process.stdout.on("resize", () => {
    if (tuiMode === "chat") {
      setScrollRegion();
      statusBar();
      prompt(true);
    }
  });

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
    setScrollRegion(); // establish scroll region after banner
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
      // Just update bottom bar in-place — no scrollback output
      prompt(true);
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
          // Show matches in scroll area, then redraw prompt
          cursorToScrollEnd();
          w.write(`\n${s.dim("  " + matches.join("  "))}\n`);
          prompt(true);
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
            cursorToScrollEnd();
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
            prompt(true);
            w.write(inputLine);
            const back = inputLine.length - cursorPos;
            if (back > 0) w.write(`${ESC}${back}D`);
          }
        } catch { /* dir doesn't exist or unreadable */ }
        return;
      }
      // Default: toggle menu mode
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

    // Escape — exit bash mode, or clear input
    if (key.name === "escape") {
      if (bashMode) {
        bashMode = false;
        inputLine = "";
        cursorPos = 0;
        prompt(true);
        return;
      }
      if (inputLine) {
        inputLine = "";
        cursorPos = 0;
        prompt(true);
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
        prompt(true);
        ctrlCCount = 0;
        return;
      }
      if (inputLine) {
        // Clear input
        inputLine = "";
        cursorPos = 0;
        prompt(true);
        ctrlCCount = 0;
        return;
      }
      // Nothing to cancel — progressive quit
      ctrlCCount++;
      if (ctrlCCount === 1) {
        w.write(s.dim("\n  Press Ctrl+C again to exit.\n"));
        prompt(true);
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
      // Move to the bottom of the scroll region so new output scrolls naturally
      cursorToScrollEnd();
      w.write("\n");

      if (!line) { prompt(); return; }

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
              const resolved = require("path").resolve(process.cwd(), target);
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
        provider: config.provider,
        systemPrompt: config.systemPrompt,
        spawner,
        sessionId: config.sessionId,
        startTime,
        phrenPath: config.phrenCtx?.phrenPath,
        phrenCtx: config.phrenCtx,
        onModelChange: (result) => {
          // Live model switch — re-resolve provider with new model
          try {
            const { resolveProvider } = require("./providers/resolve.js") as typeof import("./providers/resolve.js");
            const newProvider = resolveProvider(config.provider.name, result.model);
            config.provider = newProvider;
            // Rebuild system prompt with new model info
            const { buildSystemPrompt } = require("./system-prompt.js") as typeof import("./system-prompt.js");
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
        prompt(true);
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

  function flushTextBuffer() {
    if (!textBuffer) return;
    w.write(renderMarkdown(textBuffer));
    textBuffer = "";
  }

  const tuiHooks: TurnHooks = {
    onTextDelta: (text) => {
      if (firstDelta) {
        w.write(`${ESC}2K\r`); // clear thinking timer line
        firstDelta = false;
      }
      // Stream directly for real-time feel — write each delta immediately
      w.write(text);
    },
    onTextDone: () => {
      flushTextBuffer();
    },
    onTextBlock: (text) => {
      w.write(renderMarkdown(text));
      if (!text.endsWith("\n")) w.write("\n");
    },
    onToolStart: (name, input, count) => {
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
    cursorToScrollEnd(); // ensure all turn output stays within scroll region
    const thinkStart = Date.now();
    // Phren thinking — subtle purple/cyan breath, no spinner gimmicks
    let thinkFrame = 0;
    const thinkTimer = setInterval(() => {
      const elapsed = (Date.now() - thinkStart) / 1000;
      // Gentle sine-wave interpolation between phren purple and cyan
      const t = (Math.sin(thinkFrame * 0.08) + 1) / 2; // 0..1, slow oscillation
      const r = Math.round(155 * (1 - t) + 40 * t);
      const g = Math.round(140 * (1 - t) + 211 * t);
      const b = Math.round(250 * (1 - t) + 242 * t);
      const color = `${ESC}38;2;${r};${g};${b}m`;
      w.write(`${ESC}2K  ${color}◆ thinking${ESC}0m ${s.dim(`${elapsed.toFixed(1)}s`)}\r`);
      thinkFrame++;
    }, 50);

    try {
      await runTurn(userInput, session, config, tuiHooks);
      clearInterval(thinkTimer);
      const elapsed = ((Date.now() - thinkStart) / 1000).toFixed(1);
      w.write(`${ESC}2K  ${s.dim(`◆ thought for ${elapsed}s`)}\n`);
      statusBar();
    } catch (err: unknown) {
      clearInterval(thinkTimer);
      const msg = err instanceof Error ? err.message : String(err);
      w.write(`${ESC}2K\r`);
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
