import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useStdout } from "ink";
import { PhrenInput } from "./PhrenInput.js";
import { PERMISSION_LABELS, PERMISSION_ICONS } from "../ansi.js";
export function InputArea({ value, onChange, onSubmit, bashMode, focus, separatorColor, theme }) {
    const { stdout } = useStdout();
    const columns = stdout?.columns || 80;
    const sep = "\u2500".repeat(columns);
    const sepColor = theme?.input.separator ?? separatorColor ?? "gray";
    const promptColor = theme?.input.prompt ?? undefined;
    const bashPromptColor = theme?.input.bashPrompt ?? "yellow";
    return (_jsxs(Box, { flexDirection: "row", borderStyle: "round", borderColor: sepColor, borderLeft: false, borderRight: false, borderTop: true, borderBottom: true, width: columns, marginTop: 1, children: [bashMode
                ? _jsx(Text, { color: bashPromptColor, children: "! " })
                : _jsxs(Text, { color: promptColor, dimColor: true, children: ["\u276f", " "] }), _jsx(PhrenInput, { value: value, onChange: onChange, onSubmit: onSubmit, focus: focus })] }));
}
const STATUS_ICON = {
    running: "\u25cf", // ●
    idle: "\u25cb", // ○
    done: "\u2713", // ✓
    error: "\u2717", // ✗
    starting: "\u25cc", // ◌
    cancelled: "\u2500", // ─
};
export function PermissionsLine({ mode, theme, running, agents, selectedAgentId, highlightedTabId, tabFocused }) {
    const icon = PERMISSION_ICONS[mode];
    const label = PERMISSION_LABELS[mode];
    const permColors = theme?.permission;
    const color = mode === "suggest"
        ? (permColors?.suggest ?? "")
        : mode === "auto-confirm"
            ? (permColors?.auto ?? "blue")
            : mode === "plan"
                ? (permColors?.plan ?? "magenta")
                : (permColors?.fullAuto ?? "green");
    const showPerm = mode !== "suggest";
    const hasAgents = agents && agents.length > 0;
    // Agent tab status → theme color
    const tabColors = theme?.agentTab;
    function agentTabColor(agent) {
        if (tabColors) {
            if (agent.status === "running")
                return tabColors.running;
            if (agent.status === "idle")
                return tabColors.idle;
            if (agent.status === "done")
                return tabColors.done;
            if (agent.status === "error")
                return tabColors.error;
        }
        return agent.color;
    }
    return (_jsxs(Box, { children: [showPerm ? (_jsxs(Text, { children: ["  ", _jsxs(Text, { color: color, children: [icon, " ", label] }), _jsxs(Text, { dimColor: true, children: [" (shift+tab to cycle)", running ? " \u00b7 esc to interrupt" : ""] })] })) : (_jsxs(Text, { children: ["  ", running ? _jsx(Text, { dimColor: true, children: "esc to interrupt" }) : null] })), hasAgents ? (_jsxs(Text, { children: ["  ", agents.map((agent, i) => {
                        const isActive = agent.id === selectedAgentId;
                        const isHighlighted = tabFocused && agent.id === highlightedTabId;
                        const statusIcon = STATUS_ICON[agent.status];
                        const resolvedColor = agentTabColor(agent);
                        return (_jsxs(Text, { children: [i > 0 ? " " : "", isHighlighted
                                    ? _jsx(Text, { bold: true, inverse: true, color: resolvedColor, children: ` ${statusIcon} ${agent.name} ` })
                                    : isActive
                                        ? _jsxs(Text, { bold: true, underline: true, color: resolvedColor, children: [statusIcon, " ", agent.name] })
                                        : _jsxs(Text, { color: resolvedColor, dimColor: agent.status === "idle" || agent.status === "done", children: [statusIcon, " ", agent.name] })] }, agent.id));
                    }), tabFocused
                        ? _jsx(Text, { dimColor: true, children: "  \u2190\u2192 enter \u2191 back" })
                        : _jsx(Text, { dimColor: true, children: "  \u2193" })] })) : null] }));
}
