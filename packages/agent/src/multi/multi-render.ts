import type { AgentSpawner } from "./spawner.js";
import type { AgentStatus } from "./types.js";
import { getAgentStyle, formatAgentName } from "./agent-colors.js";
import type { Pane } from "./pane.js";
import { MAX_SCROLLBACK } from "./pane.js";

// ── ANSI helpers (mirrors tui.ts pattern) ────────────────────────────────────

export const ESC = "\x1b[";
export const s = {
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

export function statusColor(status: AgentStatus): (t: string) => string {
  switch (status) {
    case "starting": return s.yellow;
    case "running": return s.green;
    case "done": return s.gray;
    case "error": return s.red;
    case "cancelled": return s.gray;
  }
}

export function formatToolStart(toolName: string, input: Record<string, unknown>): string {
  const preview = JSON.stringify(input).slice(0, 60);
  return s.dim(`  > ${toolName}(${preview})...`);
}

export function formatToolEnd(
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

  const allLines = output.split("\n");
  const w = cols();
  const body = allLines.slice(0, 4).map((l) => s.dim(`  | ${l.slice(0, w - 6)}`)).join("\n");
  const more = allLines.length > 4 ? `\n${s.dim(`  | ... (${allLines.length} lines)`)}` : "";

  return `${header}\n${body}${more}`;
}

export function renderTopBar(
  spawner: AgentSpawner,
  panes: Map<string, Pane>,
  selectedId: string | null,
): string {
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

export function renderMainArea(
  panes: Map<string, Pane>,
  selectedId: string | null,
  scrollOffset: number,
): string[] {
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

export function renderBottomBar(spawner: AgentSpawner): string {
  const w_ = cols();
  const agentCount = spawner.listAgents().length;
  const runningCount = spawner.getAgentsByStatus("running").length;
  const left = ` Agents: ${agentCount} (${runningCount} running)`;
  const right = `1-9:select  Ctrl+</>:cycle  /spawn /list /kill /broadcast  Ctrl+D:exit `;
  const pad = Math.max(0, w_ - left.length - right.length);
  return s.invert(left + " ".repeat(pad) + right);
}

export function render(
  w: NodeJS.WriteStream,
  spawner: AgentSpawner,
  panes: Map<string, Pane>,
  selectedId: string | null,
  scrollOffset: number,
  inputLine: string,
): void {
  // Hide cursor, move to top, clear screen
  w.write(`${ESC}?25l${ESC}H${ESC}2J`);

  // Top bar
  w.write(renderTopBar(spawner, panes, selectedId));
  w.write("\n");

  // Main area
  const mainLines = renderMainArea(panes, selectedId, scrollOffset);
  for (const line of mainLines) {
    w.write(line + "\n");
  }

  // Bottom bar
  w.write(renderBottomBar(spawner));
  w.write("\n");

  // Input line
  const prompt = s.cyan("multi> ");
  w.write(prompt + inputLine);

  // Show cursor
  w.write(`${ESC}?25h`);
}
