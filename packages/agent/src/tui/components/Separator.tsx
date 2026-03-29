import React from "react";
import { Text, useStdout } from "ink";

export function Separator() {
  const { stdout } = useStdout();
  const columns = stdout?.columns || 80;
  return <Text dimColor>{"\u2500".repeat(columns)}</Text>;
}
