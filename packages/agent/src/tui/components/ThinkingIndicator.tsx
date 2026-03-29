import React, { useState, useEffect, useMemo } from "react";
import { Text } from "ink";

export interface ThinkingIndicatorProps {
  startTime: number;
}

// Phren's own thinking verbs — memory-oriented, not generic
const THINKING_VERBS = [
  "thinking", "reasoning", "recalling", "connecting", "processing",
];

export function ThinkingIndicator({ startTime }: ThinkingIndicatorProps) {
  const [frame, setFrame] = useState(0);

  // Pick a random verb once per mount
  const verb = useMemo(
    () => THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)],
    [],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => f + 1);
    }, 50);
    return () => clearInterval(timer);
  }, []);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Gentle sine-wave interpolation between phren purple and cyan
  const t = (Math.sin(frame * 0.08) + 1) / 2;
  const r = Math.round(155 * (1 - t) + 40 * t);
  const g = Math.round(140 * (1 - t) + 211 * t);
  const b = Math.round(250 * (1 - t) + 242 * t);
  const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;

  return (
    <Text>
      {"  "}<Text color={hex}>{"\u25c6"} {verb}</Text> <Text dimColor>{elapsed}s</Text>
    </Text>
  );
}
