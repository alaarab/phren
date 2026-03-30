import React from "react";
import { Box, Text } from "ink";
import { formatToolInput, formatDuration, fileLink, isFileToolPreview } from "../tool-render.js";
import type { Theme } from "../themes.js";

export interface ToolCallProps {
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  durationMs: number;
  diffRendered?: string;
}

const VERBOSE_LINES = 5;

export function ToolCall({ name, input, output, isError, durationMs, diffRendered, verbose, theme }: ToolCallProps & { verbose?: boolean; theme?: Theme }) {
  const rawPreview = formatToolInput(name, input);
  const preview = isFileToolPreview(name) && rawPreview ? fileLink(rawPreview) : rawPreview;
  const dur = formatDuration(durationMs);
  const statusColor = isError ? (theme?.tool.error ?? "red") : (theme?.tool.success ?? "green");
  const nameColor = theme?.tool.name ?? undefined;
  const previewColor = theme?.tool.preview ?? theme?.separator ?? "gray";
  const durationColor = theme?.tool.duration ?? undefined;
  const outputColor = theme?.tool.output ?? undefined;

  if (!verbose) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box>
          <Text color={statusColor}>{isError ? "\u2717" : "\u2192"} </Text>
          <Text bold color={nameColor}>{name}</Text>
          <Text color={previewColor}> {preview}</Text>
          <Text color={durationColor} dimColor>  {dur}</Text>
        </Box>
        {diffRendered && (
          <Text>{diffRendered}</Text>
        )}
      </Box>
    );
  }

  const allLines = output.split("\n").filter(Boolean);
  const shown = allLines.slice(0, VERBOSE_LINES);
  const overflow = allLines.length - VERBOSE_LINES;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color={statusColor}>{isError ? "\u2717" : "\u2192"} </Text>
        <Text bold color={nameColor}>{name}</Text>
        <Text color={previewColor}> {preview}</Text>
        <Text color={durationColor} dimColor>  {dur}</Text>
      </Box>
      {diffRendered ? (
        <Text>{diffRendered}</Text>
      ) : (
        <>
          {shown.map((line, i) => (
            <Text key={i} color={outputColor} dimColor>{"    " + line.slice(0, 120)}</Text>
          ))}
          {overflow > 0 && (
            <Text color={outputColor} dimColor>{"    ... +" + overflow + " lines"}</Text>
          )}
        </>
      )}
    </Box>
  );
}
