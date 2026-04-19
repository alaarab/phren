import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { Box, Text } from "ink";
import { formatToolInput, formatDuration, fileLink, isFileToolPreview } from "../tool-render.js";
const FOLD_LINES = 3;
export function ToolCall({ name, input, output, isError, durationMs, diffRendered, verbose, theme, expanded }) {
    const rawPreview = formatToolInput(name, input);
    const preview = isFileToolPreview(name) && rawPreview ? fileLink(rawPreview) : rawPreview;
    const dur = formatDuration(durationMs);
    const statusColor = isError ? (theme?.tool.error ?? "red") : (theme?.tool.success ?? "green");
    const nameColor = theme?.tool.name ?? undefined;
    const previewColor = theme?.tool.preview ?? theme?.separator ?? "gray";
    const durationColor = theme?.tool.duration ?? undefined;
    const outputColor = theme?.tool.output ?? undefined;
    // Header: ◇ Name(preview)  dur
    const header = (_jsxs(Box, { children: [_jsxs(Text, { color: statusColor, children: [isError ? "\u2717" : "\u25c7", " "] }), _jsx(Text, { bold: true, color: nameColor, children: name }), preview ? _jsxs(Text, { color: previewColor, children: ["(", preview, ")"] }) : null, _jsxs(Text, { color: durationColor, dimColor: true, children: ["  ", dur] })] }));
    if (!verbose) {
        return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, children: [header, diffRendered && (_jsxs(Text, { children: ["  \u23bf  ", diffRendered] }))] }));
    }
    const allLines = output.split("\n").filter(Boolean);
    const shown = expanded ? allLines : allLines.slice(0, FOLD_LINES);
    const overflow = allLines.length - FOLD_LINES;
    return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, children: [header, diffRendered ? (_jsxs(_Fragment, { children: [_jsxs(Text, { children: ["  \u23bf  ", diffRendered.split("\n")[0] ?? ""] }), diffRendered.split("\n").slice(1).map((line, i) => (_jsxs(Text, { children: ["     ", line] }, i)))] })) : (_jsxs(_Fragment, { children: [shown.map((line, i) => (_jsxs(Text, { color: outputColor, dimColor: true, children: [i === 0 ? "  \u23bf  " : "     ", line.slice(0, 120)] }, i))), !expanded && overflow > 0 && (_jsxs(Text, { color: outputColor, dimColor: true, children: ["     \u2026 +", overflow, " lines (ctrl+o to expand)"] }))] }))] }));
}
