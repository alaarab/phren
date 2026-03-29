import React from "react";
import { Box, Text } from "ink";
import { formatToolInput, formatDuration, COMPACT_LINES } from "../tool-render.js";

export interface ToolCallProps {
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  durationMs: number;
}

export function ToolCall({ name, input, output, isError, durationMs }: ToolCallProps) {
  const preview = formatToolInput(name, input);
  const dur = formatDuration(durationMs);
  const allLines = output.split("\n").filter(Boolean);
  const shown = allLines.slice(0, COMPACT_LINES);
  const overflow = allLines.length - COMPACT_LINES;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color={isError ? "red" : "green"}>{isError ? "\u2717" : "\u2192"} </Text>
        <Text bold>{name}</Text>
        <Text color="gray"> {preview}</Text>
        <Text dimColor>  {dur}</Text>
      </Box>
      {shown.map((line, i) => (
        <Text key={i} dimColor>{"    " + line.slice(0, 120)}</Text>
      ))}
      {overflow > 0 && (
        <Text dimColor>{"    ... +" + overflow + " lines"}</Text>
      )}
    </Box>
  );
}
