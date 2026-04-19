import { getAgentStyle, formatAgentName } from "./agent-colors.js";
// ── ANSI helpers (mirrors tui.ts pattern) ────────────────────────────────────
export const ESC = "\x1b[";
export const s = {
    reset: `${ESC}0m`,
    bold: (t) => `${ESC}1m${t}${ESC}0m`,
    dim: (t) => `${ESC}2m${t}${ESC}0m`,
    cyan: (t) => `${ESC}36m${t}${ESC}0m`,
    green: (t) => `${ESC}32m${t}${ESC}0m`,
    yellow: (t) => `${ESC}33m${t}${ESC}0m`,
    red: (t) => `${ESC}31m${t}${ESC}0m`,
    gray: (t) => `${ESC}90m${t}${ESC}0m`,
    white: (t) => `${ESC}37m${t}${ESC}0m`,
    bgGreen: (t) => `${ESC}42m${t}${ESC}0m`,
    bgRed: (t) => `${ESC}41m${t}${ESC}0m`,
    bgGray: (t) => `${ESC}100m${t}${ESC}0m`,
    bgCyan: (t) => `${ESC}46m${t}${ESC}0m`,
    bgYellow: (t) => `${ESC}43m${t}${ESC}0m`,
    invert: (t) => `${ESC}7m${t}${ESC}0m`,
};
function stripAnsi(t) {
    return t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
function cols() {
    return process.stdout.columns || 80;
}
function rows() {
    return process.stdout.rows || 24;
}
export function statusColor(status) {
    switch (status) {
        case "starting": return s.yellow;
        case "running": return s.green;
        case "idle": return s.cyan;
        case "done": return s.gray;
        case "error": return s.red;
        case "cancelled": return s.gray;
    }
}
export function formatToolStart(toolName, input) {
    const preview = JSON.stringify(input).slice(0, 60);
    return s.dim(`  > ${toolName}(${preview})...`);
}
export function formatToolEnd(toolName, input, output, isError, durationMs) {
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
export function renderTopBar(spawner, panes, selectedId) {
    const w_ = cols();
    const agents = spawner.listAgents();
    const tabs = [];
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
export function renderMainArea(panes, selectedId, scrollOffset) {
    const availRows = rows() - 3; // top bar + bottom bar + input line
    if (availRows < 1)
        return [];
    if (!selectedId || !panes.has(selectedId)) {
        const emptyMsg = s.dim("  No agent selected. Use /spawn <name> <task> to create one.");
        const lines = [emptyMsg];
        while (lines.length < availRows)
            lines.push("");
        return lines;
    }
    const pane = panes.get(selectedId);
    // Include partial line if any
    const allLines = [...pane.lines];
    if (pane.partial)
        allLines.push(pane.partial);
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
    const output = [];
    const paneStyle = getAgentStyle(pane.index);
    const linePrefix = paneStyle.color(paneStyle.icon) + " ";
    const prefixLen = 2; // icon + space
    for (const line of visible) {
        output.push(linePrefix + line.slice(0, w_ - prefixLen));
    }
    // Pad remaining rows
    while (output.length < availRows)
        output.push("");
    return output;
}
export function renderBottomBar(spawner) {
    const w_ = cols();
    const agentCount = spawner.listAgents().length;
    const runningCount = spawner.getAgentsByStatus("running").length;
    const left = ` Agents: ${agentCount} (${runningCount} running)`;
    const right = `1-9:select  Ctrl+</>:cycle  /spawn /list /kill /broadcast  Ctrl+D:exit `;
    const pad = Math.max(0, w_ - left.length - right.length);
    return s.invert(left + " ".repeat(pad) + right);
}
export function render(w, spawner, panes, selectedId, scrollOffset, inputLine) {
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
