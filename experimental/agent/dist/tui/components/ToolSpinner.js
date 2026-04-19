import { jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { Text } from "ink";
const FRAMES = ["\u25CC", "\u25CD", "\u25CF", "\u25CD"]; // ◌ ◍ ● ◍
export function ToolSpinner({ theme } = {}) {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 150);
        return () => clearInterval(timer);
    }, []);
    const color = theme?.accent ?? "magenta";
    return _jsxs(Text, { color: color, children: [FRAMES[frame], " "] });
}
