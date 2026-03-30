import React, { useState, useEffect, useMemo } from "react";
import { Text } from "ink";
import type { Theme } from "../themes.js";

export interface ThinkingIndicatorProps {
  startTime: number;
  theme: Theme;
}

// Phren's own thinking verbs — memory-oriented, not generic
const THINKING_VERBS = [
  "thinking", "reasoning", "recalling", "connecting", "processing",
];

export function ThinkingIndicator({ startTime, theme }: ThinkingIndicatorProps) {
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

  // Gentle sine-wave interpolation between theme thinking colors
  const t = (Math.sin(frame * 0.08) + 1) / 2;
  const [pr, pg, pb] = theme.thinking.primary;
  const [sr, sg, sb] = theme.thinking.secondary;
  const r = Math.round(pr * (1 - t) + sr * t);
  const g = Math.round(pg * (1 - t) + sg * t);
  const b = Math.round(pb * (1 - t) + sb * t);
  const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;

  return (
    <Text>
      {"  "}<Text color={hex}>{"\u25c6"} {verb}</Text> <Text dimColor>{elapsed}s</Text>
    </Text>
  );
}
