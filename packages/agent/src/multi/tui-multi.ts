/**
 * Multiplexed TUI for multi-agent orchestration.
 *
 * Full alternate-screen terminal with:
 * - Top bar: agent tabs with status color coding
 * - Main area: scrollback buffer for the selected agent
 * - Bottom bar: input line + keyboard hints
 *
 * Keyboard:
 *   1-9              Select agent pane by index
 *   Ctrl+Left/Right  Cycle between agent panes
 *   Enter            Send input / execute command
 *   /spawn <n> <t>   Spawn a new agent
 *   /list            List all agents
 *   /kill <name>     Terminate an agent
 *   /broadcast <msg> Send message to all agents
 *   Ctrl+D           Exit (kills all agents)
 */

import * as readline from "node:readline";
import type { AgentSpawner, SpawnOptions } from "./spawner.js";
import type { AgentConfig } from "../agent-loop.js";
import type { AgentStatus } from "./types.js";
import { getAgentStyle, formatAgentName } from "./agent-colors.js";
import { decodeDiffPayload, renderInlineDiff, DIFF_MARKER } from "./diff-renderer.js";

// ── ANSI helpers (mirrors tui.ts pattern) ────────────────────────────────────

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
  white: (t: string) => `${ESC}37m${t}${ESC}0m`,
  bgGreen: (t: string) => `${ESC}42m${t}${ESC}0m`,
  bgRed: (t: string) => `${ESC}41m${t}${ESC}0m`,
  bgGray: (t: string) => `${ESC}100m${t}${ESC}0m`,
  bgCyan: (t: string) => `${ESC}46m${t}${ESC}0m`,
  bgYellow: (t: string) => `${ESC}43m${t}${ESC}0m`,
  invert: (t: string) => `${ESC}7m${t}${ESC}0m`,
};

function stripAnsi(t: string): string {
  return t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function cols(): number {
  return process.stdout.columns || 80;
}

function rows(): number {
  return process.stdout.rows || 24;
}

// ── Pane buffer ──────────────────────────────────────────────────────────────

const MAX_SCROLLBACK = 1000;

interface Pane {
  agentId: string;
  name: string;
  /** Stable index for color/icon assignment. */
  index: number;
  lines: string[];
  /** Partial line accumulator for streaming text deltas */
  partial: string;
}

let nextPaneIndex = 0;

function createPane(agentId: string, name: string): Pane {
  return { agentId, name, index: nextPaneIndex++, lines: [], partial: "" };
}

function appendToPane(pane: Pane, text: string): void {
  // Merge with partial line buffer
  const combined = pane.partial + text;
  const parts = combined.split("\n");

  // Everything except the last segment is a complete line
  for (let i = 0; i < parts.length - 1; i++) {
    pane.lines.push(parts[i]);
  }
  pane.partial = parts[parts.length - 1];

  // Enforce scrollback cap
  if (pane.lines.length > MAX_SCROLLBACK) {
    pane.lines.splice(0, pane.lines.length - MAX_SCROLLBACK);
  }
}

function flushPartial(pane: Pane): void {
  if (pane.partial) {
    pane.lines.push(pane.partial);
    pane.partial = "";
  }
}

// ── Status color ─────────────────────────────────────────────────────────────

function statusColor(status: AgentStatus): (t: string) => string {
  switch (status) {
    case "starting": return s.yellow;
    case "running": return s.green;
    case "done": return s.gray;
    case "error": return s.red;
    case "cancelled": return s.gray;
  }
}

// ── Tool call formatting ─────────────────────────────────────────────────────

function formatToolStart(toolName: string, input: Record<string, unknown>): string {
  const preview = JSON.stringify(input).slice(0, 60);
  return s.dim(`  > ${toolName}(${preview})...`);
}

function formatToolEnd(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
  durationMs: number,
): string {
  const dur = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  const icon = isError ? s.red("x") : s.green("ok");
  const preview = JSON.stringify(input).slice(0, 50);
  const header = s.dim(`  ${toolName}(${preview})`) + ` ${icon} ${s.dim(dur)}`;

  const outputLines = output.split("\n").slice(0, 4);
  const w = cols();
  const body = outputLines.map((l) => s.dim(`  | ${l.slice(0, w - 6)}`)).join("\n");
  const more = output.split("\n").length > 4 ? s.dim(`  | ... (${output.split("\n").length} lines)`) : "";

  return `${header}\n${body}${more ? "\n" + more : ""}`;
}

// ── Main TUI ─────────────────────────────────────────────────────────────────

export async function startMultiTui(
  spawner: AgentSpawner,
  config: AgentConfig,
): Promise<void> {
  const w = process.stdout;
  const panes = new Map<string, Pane>();
  let selectedId: string | null = null;
  let inputLine = "";
  let scrollOffset = 0;

  // Ordered list of agent IDs for tab navigation
  const agentOrder: string[] = [];

  // ── Pane management ────────────────────────────────────────────────────

  function getOrCreatePane(agentId: string): Pane {
    let pane = panes.get(agentId);
    if (!pane) {
      const agent = spawner.getAgent(agentId);
      const name = agent?.task.slice(0, 20) ?? agentId;
      pane = createPane(agentId, name);
      panes.set(agentId, pane);
      if (!agentOrder.includes(agentId)) {
        agentOrder.push(agentId);
      }
      // Auto-select first agent
      if (!selectedId) {
        selectedId = agentId;
      }
    }
    return pane;
  }

  function selectAgent(agentId: string): void {
    if (panes.has(agentId)) {
      selectedId = agentId;
      scrollOffset = 0;
      render();
    }
  }

  function selectByIndex(index: number): void {
    if (index >= 0 && index < agentOrder.length) {
      selectAgent(agentOrder[index]);
    }
  }

  function cycleAgent(direction: number): void {
    if (agentOrder.length === 0) return;
    const currentIdx = selectedId ? agentOrder.indexOf(selectedId) : -1;
    let next = currentIdx + direction;
    if (next < 0) next = agentOrder.length - 1;
    if (next >= agentOrder.length) next = 0;
    selectAgent(agentOrder[next]);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function renderTopBar(): string {
    const w_ = cols();
    const agents = spawner.listAgents();
    const tabs: string[] = [];

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const isSel = a.id === selectedId;
      const pane = panes.get(a.id);
      const paneIdx = pane?.index ?? i;
      const stColor = statusColor(a.status);
      const agentLabel = formatAgentName(pane?.name ?? a.task.slice(0, 12), paneIdx);
      const statusTag = stColor(a.status);
      const raw = ` ${i + 1}:${stripAnsi(agentLabel)} [${stripAnsi(statusTag)}] `;
      const colored = ` ${i + 1}:${agentLabel} [${statusTag}] `;
      const tab = isSel ? s.invert(raw) : colored;
      tabs.push(tab);
    }

    if (agents.length === 0) {
      tabs.push(s.dim(" no agents "));
    }

    const title = s.bold(" phren-multi ");
    const tabStr = tabs.join(s.dim("|"));
    const line = title + s.dim("|") + tabStr;
    const pad = Math.max(0, w_ - stripAnsi(line).length);
    return s.invert(stripAnsi(title)) + s.dim("|") + tabStr + " ".repeat(pad);
  }

  function renderMainArea(): string[] {
    const availRows = rows() - 3; // top bar + bottom bar + input line
    if (availRows < 1) return [];

    if (!selectedId || !panes.has(selectedId)) {
      const emptyMsg = s.dim("  No agent selected. Use /spawn <name> <task> to create one.");
      const lines: string[] = [emptyMsg];
      while (lines.length < availRows) lines.push("");
      return lines;
    }

    const pane = panes.get(selectedId)!;
    // Include partial line if any
    const allLines = [...pane.lines];
    if (pane.partial) allLines.push(pane.partial);

    // Apply scroll offset
    const totalLines = allLines.length;
    let start = Math.max(0, totalLines - availRows - scrollOffset);
    let end = start + availRows;
    if (end > totalLines) {
      end = totalLines;
      start = Math.max(0, end - availRows);
    }

    const visible = allLines.slice(start, end);
    const w_ = cols();

    const output: string[] = [];
    const paneStyle = getAgentStyle(pane.index);
    const linePrefix = paneStyle.color(paneStyle.icon) + " ";
    const prefixLen = 2; // icon + space
    for (const line of visible) {
      output.push(linePrefix + line.slice(0, w_ - prefixLen));
    }

    // Pad remaining rows
    while (output.length < availRows) output.push("");

    return output;
  }

  function renderBottomBar(): string {
    const w_ = cols();
    const agentCount = spawner.listAgents().length;
    const runningCount = spawner.getAgentsByStatus("running").length;
    const left = ` Agents: ${agentCount} (${runningCount} running)`;
    const right = `1-9:select  Ctrl+</>:cycle  /spawn /list /kill /broadcast  Ctrl+D:exit `;
    const pad = Math.max(0, w_ - left.length - right.length);
    return s.invert(left + " ".repeat(pad) + right);
  }

  function renderInputLine(): string {
    const prompt = s.cyan("multi> ");
    return prompt + inputLine;
  }

  function render(): void {
    // Hide cursor, move to top, clear screen
    w.write(`${ESC}?25l${ESC}H${ESC}2J`);

    // Top bar
    w.write(renderTopBar());
    w.write("\n");

    // Main area
    const mainLines = renderMainArea();
    for (const line of mainLines) {
      w.write(line + "\n");
    }

    // Bottom bar
    w.write(renderBottomBar());
    w.write("\n");

    // Input line
    w.write(renderInputLine());

    // Show cursor
    w.write(`${ESC}?25h`);
  }

  // ── Spawner event wiring ───────────────────────────────────────────────

  spawner.on("text_delta", (agentId: string, text: string) => {
    const pane = getOrCreatePane(agentId);
    appendToPane(pane, text);
    if (agentId === selectedId) render();
  });

  spawner.on("text_block", (agentId: string, text: string) => {
    const pane = getOrCreatePane(agentId);
    appendToPane(pane, text + "\n");
    if (agentId === selectedId) render();
  });

  spawner.on("tool_start", (agentId: string, toolName: string, input: Record<string, unknown>) => {
    const pane = getOrCreatePane(agentId);
    flushPartial(pane);
    appendToPane(pane, formatToolStart(toolName, input) + "\n");
    if (agentId === selectedId) render();
  });

  spawner.on("tool_end", (agentId: string, toolName: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number) => {
    const pane = getOrCreatePane(agentId);
    flushPartial(pane);
    const diffData = (toolName === "edit_file" || toolName === "write_file") ? decodeDiffPayload(output) : null;
    const cleanOutput = diffData ? output.slice(0, output.indexOf(DIFF_MARKER)) : output;
    appendToPane(pane, formatToolEnd(toolName, input, cleanOutput, isError, durationMs) + "\n");
    if (diffData) {
      appendToPane(pane, renderInlineDiff(diffData.oldContent, diffData.newContent, diffData.filePath) + "\n");
    }
    if (agentId === selectedId) render();
  });

  spawner.on("status", (agentId: string, message: string) => {
    const pane = getOrCreatePane(agentId);
    appendToPane(pane, s.dim(message) + "\n");
    if (agentId === selectedId) render();
  });

  spawner.on("done", (agentId: string, result: { finalText: string; turns: number; toolCalls: number; totalCost?: string }) => {
    const pane = getOrCreatePane(agentId);
    flushPartial(pane);
    const style = getAgentStyle(pane.index);
    appendToPane(pane, "\n" + style.color(`--- ${style.icon} Agent completed ---`) + "\n");
    appendToPane(pane, s.dim(`  Turns: ${result.turns}  Tool calls: ${result.toolCalls}${result.totalCost ? `  Cost: ${result.totalCost}` : ""}`) + "\n");
    render();
  });

  spawner.on("error", (agentId: string, error: string) => {
    const pane = getOrCreatePane(agentId);
    flushPartial(pane);
    const style = getAgentStyle(pane.index);
    appendToPane(pane, "\n" + style.color(`--- ${style.icon} Error: ${error} ---`) + "\n");
    render();
  });

  spawner.on("exit", (agentId: string, code: number | null) => {
    const pane = getOrCreatePane(agentId);
    if (code !== null && code !== 0) {
      appendToPane(pane, s.dim(`  Process exited with code ${code}`) + "\n");
    }
    render();
  });

  spawner.on("message", (from: string, to: string, content: string) => {
    // Show in sender's pane
    const senderPane = panes.get(from);
    if (senderPane) {
      flushPartial(senderPane);
      const toName = panes.get(to)?.name ?? to;
      appendToPane(senderPane, s.yellow(`[${senderPane.name} -> ${toName}] ${content}`) + "\n");
    }
    // Show in recipient's pane
    const recipientPane = panes.get(to);
    if (recipientPane) {
      flushPartial(recipientPane);
      const fromName = senderPane?.name ?? from;
      appendToPane(recipientPane, s.yellow(`[${fromName} -> ${recipientPane.name}] ${content}`) + "\n");
    }
    if (from === selectedId || to === selectedId) render();
  });

  // ── Slash command handling ─────────────────────────────────────────────

  function handleSlashCommand(line: string): boolean {
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === "/spawn") {
      const name = parts[1];
      const task = parts.slice(2).join(" ");
      if (!name || !task) {
        appendToSystem("Usage: /spawn <name> <task>");
        return true;
      }
      const opts: SpawnOptions = {
        task,
        cwd: process.cwd(),
        provider: config.provider.name,
        permissions: "auto-confirm",
        verbose: config.verbose,
      };
      const agentId = spawner.spawn(opts);
      const pane = getOrCreatePane(agentId);
      pane.name = name;
      appendToPane(pane, s.cyan(`Spawned agent "${name}" (${agentId}): ${task}`) + "\n");
      selectAgent(agentId);
      return true;
    }

    if (cmd === "/list") {
      const agents = spawner.listAgents();
      if (agents.length === 0) {
        appendToSystem("No agents.");
      } else {
        const lines: string[] = ["Agents:"];
        for (let i = 0; i < agents.length; i++) {
          const a = agents[i];
          const pane = panes.get(a.id);
          const name = pane?.name ?? a.id;
          const color = statusColor(a.status);
          const elapsed = a.finishedAt
            ? `${((a.finishedAt - a.startedAt) / 1000).toFixed(1)}s`
            : `${((Date.now() - a.startedAt) / 1000).toFixed(0)}s`;
          lines.push(`  ${i + 1}. ${name} [${color(a.status)}] ${s.dim(elapsed)} — ${a.task.slice(0, 50)}`);
        }
        appendToSystem(lines.join("\n"));
      }
      return true;
    }

    if (cmd === "/kill") {
      const target = parts[1];
      if (!target) {
        appendToSystem("Usage: /kill <name|index>");
        return true;
      }
      const agentId = resolveAgentTarget(target);
      if (!agentId) {
        appendToSystem(`Agent "${target}" not found.`);
        return true;
      }
      const ok = spawner.cancel(agentId);
      const pane = getOrCreatePane(agentId);
      if (ok) {
        appendToPane(pane, s.yellow("\n--- Cancelled ---\n"));
      } else {
        appendToSystem(`Agent "${target}" is not running.`);
      }
      render();
      return true;
    }

    if (cmd === "/broadcast") {
      const msg = parts.slice(1).join(" ");
      if (!msg) {
        appendToSystem("Usage: /broadcast <message>");
        return true;
      }
      const agents = spawner.listAgents();
      let sent = 0;
      for (const a of agents) {
        if (a.status === "running") {
          const pane = getOrCreatePane(a.id);
          appendToPane(pane, s.yellow(`[broadcast] ${msg}`) + "\n");
          sent++;
        }
      }
      appendToSystem(`Broadcast sent to ${sent} running agent(s).`);
      return true;
    }

    if (cmd === "/msg") {
      const target = parts[1];
      const msg = parts.slice(2).join(" ");
      if (!target || !msg) {
        appendToSystem("Usage: /msg <agent> <text>");
        return true;
      }
      const agentId = resolveAgentTarget(target);
      if (!agentId) {
        appendToSystem(`Agent "${target}" not found.`);
        return true;
      }
      const ok = spawner.sendToAgent(agentId, msg, "user");
      if (ok) {
        const recipientPane = getOrCreatePane(agentId);
        flushPartial(recipientPane);
        appendToPane(recipientPane, s.yellow(`[user -> ${recipientPane.name}] ${msg}`) + "\n");
        if (selectedId && selectedId !== agentId && panes.has(selectedId)) {
          const curPane = panes.get(selectedId)!;
          flushPartial(curPane);
          appendToPane(curPane, s.yellow(`[user -> ${recipientPane.name}] ${msg}`) + "\n");
        }
      } else {
        appendToSystem(`Agent "${target}" is not running.`);
      }
      render();
      return true;
    }

    if (cmd === "/help") {
      appendToSystem([
        "Commands:",
        "  /spawn <name> <task>  — Spawn a new agent",
        "  /list                 — List all agents",
        "  /kill <name|index>    — Terminate an agent",
        "  /msg <agent> <text>   — Send direct message to an agent",
        "  /broadcast <msg>      — Send to all running agents",
        "  /help                 — Show this help",
        "",
        "Keys:",
        "  1-9                   — Select agent by number",
        "  Ctrl+Left/Right       — Cycle agents",
        "  PageUp/PageDown       — Scroll output",
        "  Ctrl+D                — Exit (kills all)",
      ].join("\n"));
      return true;
    }

    return false;
  }

  function resolveAgentTarget(target: string): string | null {
    // Try numeric index (1-based)
    const idx = parseInt(target, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= agentOrder.length) {
      return agentOrder[idx - 1];
    }
    // Try name match
    for (const [id, pane] of panes) {
      if (pane.name === target) return id;
    }
    // Try agent ID
    if (spawner.getAgent(target)) return target;
    return null;
  }

  function appendToSystem(text: string): void {
    if (!selectedId || !panes.has(selectedId)) {
      // Create a virtual system pane
      const pane = createPane("_system", "system");
      panes.set("_system", pane);
      if (!agentOrder.includes("_system")) agentOrder.push("_system");
      selectedId = "_system";
      appendToPane(pane, text + "\n");
    } else {
      const pane = panes.get(selectedId)!;
      flushPartial(pane);
      appendToPane(pane, text + "\n");
    }
    render();
  }

  // ── Terminal setup ─────────────────────────────────────────────────────

  // Enter alternate screen
  w.write("\x1b[?1049h");

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  }

  function cleanup(): void {
    w.write("\x1b[?1049l"); // leave alternate screen
    w.write(`${ESC}?25h`);  // show cursor
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
  }

  // ── Promise-based lifecycle ────────────────────────────────────────────

  return new Promise<void>((resolve) => {
    async function shutdown(): Promise<void> {
      cleanup();
      w.write(s.dim("Shutting down agents...\n"));
      await spawner.shutdown();
      w.write(s.dim("All agents stopped.\n"));
      resolve();
    }

    // ── Keypress handler ─────────────────────────────────────────────────

    process.stdin.on("keypress", (_ch: string | undefined, key: readline.Key) => {
      if (!key) return;

      // Ctrl+D — exit
      if (key.ctrl && key.name === "d") {
        shutdown();
        return;
      }

      // Ctrl+C — clear input or exit if empty
      if (key.ctrl && key.name === "c") {
        if (inputLine.length > 0) {
          inputLine = "";
          render();
        } else {
          shutdown();
        }
        return;
      }

      // Number keys 1-9 — select agent
      if (!key.ctrl && !key.meta && key.sequence && /^[1-9]$/.test(key.sequence) && inputLine.length === 0) {
        selectByIndex(parseInt(key.sequence, 10) - 1);
        return;
      }

      // Ctrl+Left/Right — cycle agents
      if (key.ctrl && key.name === "left") {
        cycleAgent(-1);
        return;
      }
      if (key.ctrl && key.name === "right") {
        cycleAgent(1);
        return;
      }

      // Page Up/Down — scroll
      if (key.name === "pageup") {
        const availRows = rows() - 3;
        scrollOffset = Math.min(scrollOffset + Math.floor(availRows / 2), MAX_SCROLLBACK);
        render();
        return;
      }
      if (key.name === "pagedown") {
        const availRows = rows() - 3;
        scrollOffset = Math.max(0, scrollOffset - Math.floor(availRows / 2));
        render();
        return;
      }

      // Enter — submit input
      if (key.name === "return") {
        const line = inputLine.trim();
        inputLine = "";

        if (!line) {
          render();
          return;
        }

        if (line.startsWith("/")) {
          if (handleSlashCommand(line)) {
            render();
            return;
          }
        }

        // Send as text to currently selected agent's pane
        if (selectedId && panes.has(selectedId)) {
          const pane = panes.get(selectedId)!;
          appendToPane(pane, s.cyan(`> ${line}`) + "\n");
        }

        render();
        return;
      }

      // Backspace
      if (key.name === "backspace") {
        if (inputLine.length > 0) {
          inputLine = inputLine.slice(0, -1);
          render();
        }
        return;
      }

      // Regular character input
      if (key.sequence && !key.ctrl && !key.meta) {
        inputLine += key.sequence;
        render();
      }
    });

    // Handle terminal resize
    process.stdout.on("resize", () => render());

    // Initial render
    render();

    // Register panes for any agents that already exist
    for (const agent of spawner.listAgents()) {
      getOrCreatePane(agent.id);
    }
    if (agentOrder.length > 0) {
      selectedId = agentOrder[0];
    }
    render();
  });
}
