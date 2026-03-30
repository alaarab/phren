import React, { useState, useEffect } from "react";
import { Text } from "ink";

const FRAMES = ["\u25CC", "\u25CD", "\u25CF", "\u25CD"]; // ◌ ◍ ● ◍

export function ToolSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 150);
    return () => clearInterval(timer);
  }, []);
  return <Text color="magenta">{FRAMES[frame]} </Text>;
}
