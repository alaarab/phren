import { jsx as _jsx } from "react/jsx-runtime";
import { Text, useStdout } from "ink";
export function Separator() {
    const { stdout } = useStdout();
    const columns = stdout?.columns || 80;
    return _jsx(Text, { dimColor: true, children: "\u2500".repeat(columns) });
}
