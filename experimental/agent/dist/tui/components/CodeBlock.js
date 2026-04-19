import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { highlightCode } from '../../multi/syntax-highlight.js';
export function CodeBlock({ code, language }) {
    const lang = language || 'generic';
    const highlighted = highlightCode(code, lang);
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, marginBottom: 1, children: [_jsx(Text, { dimColor: true, children: '```' + lang }), _jsx(Text, { children: highlighted }), _jsx(Text, { dimColor: true, children: '```' })] }));
}
