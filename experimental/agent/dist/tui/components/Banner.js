import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
import * as os from "os";
function formatContextWindow(n) {
    if (n >= 1_000_000)
        return `${Math.round(n / 1_000_000)}M ctx`;
    if (n >= 1_000)
        return `${Math.round(n / 1_000)}k ctx`;
    return `${n} ctx`;
}
export function Banner({ state, theme }) {
    const cwd = process.cwd().replace(os.homedir(), "~");
    const logoColor = theme?.banner.logo ?? "magenta";
    const versionColor = theme?.banner.version ?? "gray";
    const cwdColor = theme?.banner.cwd ?? "cyan";
    const modelParts = [];
    if (state.model)
        modelParts.push(state.model);
    if (state.contextWindow)
        modelParts.push(formatContextWindow(state.contextWindow));
    if (state.reasoningEffort)
        modelParts.push(state.reasoningEffort);
    const modelLine = modelParts.join(" · ");
    return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, children: [_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { bold: true, color: logoColor, children: "◆ phren" }), _jsx(Text, { color: versionColor, dimColor: true, children: " v" + state.version })] }), modelLine ? (_jsx(Text, { color: versionColor, dimColor: true, children: modelLine })) : null, _jsx(Text, { color: cwdColor, dimColor: true, children: cwd }), _jsx(Text, { children: "" })] }));
}
