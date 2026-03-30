import React from "react";
import { Box, Text } from "ink";
import { formatToolInput, formatDuration } from "../tool-render.js";

export interface ToolCallProps {
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  durationMs: number;
}

const VERBOSE_LINES = 5;

export function ToolCall({ name, input, output, isError, durationMs, verbose }: ToolCallProps & { verbose?: boolean }) {
  const preview = formatToolInput(name, input);
  const dur = formatDuration(durationMs);

  if (!verbose) {
    // Non-verbose: header only, no output body
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box>
          <Text color={isError ? "red" : "green"}>{isError ? "\u2717" : "\u2192"} </Text>
          <Text bold>{name}</Text>
          <Text color="gray"> {preview}</Text>
          <Text dimColor>  {dur}</Text>
        </Box>
      </Box>
    );
  }

  // Verbose: header + first 5 lines of output + overflow count
  const allLines = output.split("\n").filter(Boolean);
  const shown = allLines.slice(0, VERBOSE_LINES);
  const overflow = allLines.length - VERBOSE_LINES;

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
