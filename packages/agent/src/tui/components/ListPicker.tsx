import { Box, Text, useInput } from "ink";
import type { Theme } from "../themes.js";

/** A pick-one list (sessions for /resume): arrows move, enter picks, esc cancels. */
export interface ListPickerState {
  title: string;
  items: Array<{ label: string; detail?: string }>;
  cursor: number;
}

export interface ListPickerProps {
  state: ListPickerState;
  theme?: Theme;
  onMove: (delta: number) => void;
  onSelect: () => void;
  onCancel: () => void;
}

/** Rows shown at once; the window follows the cursor. */
const VISIBLE = 10;

export function ListPicker({ state, theme, onMove, onSelect, onCancel }: ListPickerProps) {
  useInput((_input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { onSelect(); return; }
    if (key.upArrow) { onMove(-1); return; }
    if (key.downArrow) { onMove(1); return; }
  });

  const accent = theme?.statusBar.accent ?? "cyan";
  const start = Math.max(0, Math.min(state.cursor - Math.floor(VISIBLE / 2), state.items.length - VISIBLE));
  const shown = state.items.slice(start, start + VISIBLE);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginTop={1}>
      <Box>
        <Text bold>{state.title} </Text>
        <Text dimColor>{"↑↓ navigate · enter select · esc cancel"}</Text>
      </Box>
      {shown.map((item, offset) => {
        const i = start + offset;
        const selected = i === state.cursor;
        return (
          <Text key={i} color={selected ? accent : undefined} dimColor={!selected} wrap="truncate-end">
            {selected ? "▸ " : "  "}
            {item.label}
            {item.detail ? <Text dimColor>{"  "}{item.detail}</Text> : null}
          </Text>
        );
      })}
      {state.items.length > VISIBLE ? <Text dimColor>{`  ${state.cursor + 1} of ${state.items.length}`}</Text> : null}
    </Box>
  );
}
