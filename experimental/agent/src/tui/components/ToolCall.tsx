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

export interface ToolCallExpandProps {
  expanded?: boolean;
}

const FOLD_LINES = 3;

export function ToolCall({ name, input, output, isError, durationMs, diffRendered, verbose, theme, expanded }: ToolCallProps & ToolCallExpandProps & { verbose?: boolean; theme?: Theme }) {
  const rawPreview = formatToolInput(name, input);
  const preview = isFileToolPreview(name) && rawPreview ? fileLink(rawPreview) : rawPreview;
  const dur = formatDuration(durationMs);
  const statusColor = isError ? (theme?.tool.error ?? "red") : (theme?.tool.success ?? "green");
  const nameColor = theme?.tool.name ?? undefined;
  const previewColor = theme?.tool.preview ?? theme?.separator ?? "gray";
  const durationColor = theme?.tool.duration ?? undefined;
  const outputColor = theme?.tool.output ?? undefined;

  // Header: ◇ Name(preview)  dur
  const header = (
    <Box>
      <Text color={statusColor}>{isError ? "\u2717" : "\u25c7"} </Text>
      <Text bold color={nameColor}>{name}</Text>
      {preview ? <Text color={previewColor}>({preview})</Text> : null}
      <Text color={durationColor} dimColor>  {dur}</Text>
    </Box>
  );

  if (!verbose) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        {header}
        {diffRendered && (
          <Text>{"  \u23bf  "}{diffRendered}</Text>
        )}
      </Box>
    );
  }

  const allLines = output.split("\n").filter(Boolean);
  const shown = expanded ? allLines : allLines.slice(0, FOLD_LINES);
  const overflow = allLines.length - FOLD_LINES;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {header}
      {diffRendered ? (
        <>
          <Text>{"  \u23bf  "}{diffRendered.split("\n")[0] ?? ""}</Text>
          {diffRendered.split("\n").slice(1).map((line, i) => (
            <Text key={i}>{"     "}{line}</Text>
          ))}
        </>
      ) : (
        <>
          {shown.map((line, i) => (
            <Text key={i} color={outputColor} dimColor>{i === 0 ? "  \u23bf  " : "     "}{line.slice(0, 120)}</Text>
          ))}
          {!expanded && overflow > 0 && (
            <Text color={outputColor} dimColor>{"     \u2026 +"}{overflow}{" lines (ctrl+o to expand)"}</Text>
          )}
        </>
      )}
    </Box>
  );
}
