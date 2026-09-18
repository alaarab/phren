import { Box, Text, useInput } from "ink";
import { formatToolInput } from "../tool-render.js";
import type { ToolCallProps } from "./ToolCall.js";
import type { Theme } from "../themes.js";

export interface ToolDetailState {
  call: ToolCallProps;
  index: number;
  total: number;
}

export interface ToolDetailProps {
  detail: ToolDetailState;
  theme?: Theme;
  onMove: (delta: number) => void;
  onClose: () => void;
}

export function ToolDetail({ detail, theme, onMove, onClose }: ToolDetailProps) {
  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { onMove(-1); return; }
    if (key.downArrow) { onMove(1); return; }
  });

  const { call } = detail;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={call.isError ? "red" : (theme?.tool.name ?? "gray")} paddingX={1} marginTop={1}>
      <Box>
        <Text bold>{call.name}</Text>
        <Text dimColor>{"  "}{formatToolInput(call.name, call.input)}</Text>
        <Text dimColor>{"  ("}{detail.index + 1}{"/"}{detail.total}{" \u00b7 \u2191\u2193 \u00b7 esc)"}</Text>
      </Box>
      <Text color={call.isError ? "red" : theme?.tool.output ?? undefined} wrap="wrap">{call.output || "(no output)"}</Text>
    </Box>
  );
}
