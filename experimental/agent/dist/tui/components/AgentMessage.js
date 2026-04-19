import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
export function AgentMessage({ text }) {
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "magenta", children: ["◆", " ", _jsx(Text, { children: text })] }), _jsx(Text, { children: "" })] }));
}
