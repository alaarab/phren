import React, { useState, useEffect } from "react";
import { Text } from "ink";
import type { Theme } from "../themes.js";

const FRAMES = ["\u25CC", "\u25CD", "\u25CF", "\u25CD"]; // ◌ ◍ ● ◍

export interface ToolSpinnerProps {
  theme?: Theme;
}

export function ToolSpinner({ theme }: ToolSpinnerProps = {}) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 150);
    return () => clearInterval(timer);
  }, []);
  const color = theme?.accent ?? "magenta";
  return <Text color={color}>{FRAMES[frame]} </Text>;
}
