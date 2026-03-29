import React from "react";
import { Box, Text } from "ink";
import { formatToolInput, formatDuration } from "../tool-render.js";

export interface ToolCallEntry {
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  durationMs: number;
}

export interface ChatMessageProps {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  toolCalls?: ToolCallEntry[];
}

const COMPACT_LINES = 3;

export function ChatMessage({ role, text, toolCalls }: ChatMessageProps) {
  if (role === "user") {
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Text bold>You: </Text>
        <Text>{text}</Text>
      </Box>
    );
  }

  if (role === "system") {
    return (
      <Box marginBottom={0}>
        <Text dimColor>{text}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text>{text}</Text>
      {toolCalls?.map((tc, i) => (
        <ToolCallLine key={i} {...tc} />
      ))}
    </Box>
  );
}

function ToolCallLine({ name, input, output, isError, durationMs }: ToolCallEntry) {
  const preview = formatToolInput(name, input);
  const dur = formatDuration(durationMs);
  const icon = isError ? "✗" : "→";
  const iconColor = isError ? "red" : "green";

  const allLines = output.split("\n").filter(Boolean);
  const shown = allLines.slice(0, COMPACT_LINES);
  const overflow = allLines.length - COMPACT_LINES;

  return (
    <Box flexDirection="column">
      <Text>
        {"  "}<Text color={iconColor}>{icon}</Text>{" "}
        <Text bold>{name}</Text>{" "}
        <Text color="gray">{preview}</Text>{"  "}
        <Text dimColor>{dur}</Text>
      </Text>
      {shown.map((line, j) => (
        <Text key={j} dimColor>{"    "}{line.slice(0, (process.stdout.columns || 80) - 6)}</Text>
      ))}
      {overflow > 0 && <Text dimColor>{"    "}... +{overflow} lines</Text>}
    </Box>
  );
}
