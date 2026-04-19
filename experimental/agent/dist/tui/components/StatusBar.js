import { jsx as _jsx } from "react/jsx-runtime";
import { Text, useStdout } from "ink";
import { PERMISSION_LABELS } from "../ansi.js";
export function StatusBar({ provider, project, turns, cost, permMode, agentCount, theme }) {
    const { stdout } = useStdout();
    const width = stdout?.columns || 80;
    const modeLabel = permMode ? PERMISSION_LABELS[permMode] : "";
    const agentTag = agentCount && agentCount > 0 ? `A${agentCount}` : "";
    const leftParts = [" \u25c6 phren", provider];
    if (project)
        leftParts.push(project);
    const left = leftParts.join(" \u00b7 ");
    const rightParts = [];
    if (modeLabel)
        rightParts.push(modeLabel);
    if (agentTag)
        rightParts.push(agentTag);
    if (cost)
        rightParts.push(cost);
    rightParts.push(`T${turns}`);
    const right = rightParts.join("  ") + " ";
    const pad = Math.max(0, width - left.length - right.length);
    const fullLine = left + " ".repeat(pad) + right;
    // theme.statusBar.accent is available for future use (e.g. highlighted segments)
    const _accent = theme?.statusBar.accent;
    return _jsx(Text, { inverse: true, children: fullLine });
}
