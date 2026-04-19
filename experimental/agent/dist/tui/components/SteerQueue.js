import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from "ink";
export function SteerQueue({ items, theme }) {
    if (items.length === 0)
        return null;
    const color = theme?.steer.color ?? "yellow";
    const icon = theme?.steer.icon ?? "↳";
    return (_jsx(Box, { flexDirection: "column", children: items.map((item, i) => (_jsxs(Text, { color: color, children: ["  ", icon, " steer: ", item.slice(0, 60)] }, i))) }));
}
