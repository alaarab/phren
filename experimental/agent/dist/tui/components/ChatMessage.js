import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
import { formatToolInput, formatDuration } from "../tool-render.js";
const COMPACT_LINES = 3;
export function ChatMessage({ role, text, toolCalls }) {
    if (role === "user") {
        return (_jsxs(Box, { flexDirection: "column", marginBottom: 0, children: [_jsx(Text, { bold: true, children: "You: " }), _jsx(Text, { children: text })] }));
    }
    if (role === "system") {
        return (_jsx(Box, { marginBottom: 0, children: _jsx(Text, { dimColor: true, children: text }) }));
    }
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 0, children: [_jsx(Text, { children: text }), toolCalls?.map((tc, i) => (_jsx(ToolCallLine, { ...tc }, i)))] }));
}
function ToolCallLine({ name, input, output, isError, durationMs }) {
    const preview = formatToolInput(name, input);
    const dur = formatDuration(durationMs);
    const icon = isError ? "✗" : "→";
    const iconColor = isError ? "red" : "green";
    const allLines = output.split("\n").filter(Boolean);
    const shown = allLines.slice(0, COMPACT_LINES);
    const overflow = allLines.length - COMPACT_LINES;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { children: ["  ", _jsx(Text, { color: iconColor, children: icon }), " ", _jsx(Text, { bold: true, children: name }), " ", _jsx(Text, { color: "gray", children: preview }), "  ", _jsx(Text, { dimColor: true, children: dur })] }), shown.map((line, j) => (_jsxs(Text, { dimColor: true, children: ["    ", line.slice(0, (process.stdout.columns || 80) - 6)] }, j))), overflow > 0 && _jsxs(Text, { dimColor: true, children: ["    ", "... +", overflow, " lines"] })] }));
}
