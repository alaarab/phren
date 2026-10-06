import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { pickerRows, movePicker, pickerWindow } from "../../multi/picker-navigation.js";
import type { ModelEntry, ReasoningLevel } from "../../multi/model-picker.js";
import { REASONING_LEVELS } from "../../models.js";
import type { Theme } from "../themes.js";

export interface ModelPickerState {
  models: ModelEntry[];
  cursor: number;
  reasoning: ReasoningLevel[];
}

export interface ModelPickerProps {
  state: ModelPickerState;
  theme?: Theme;
  onMove: (delta: number) => void;
  onReasoning: (delta: number) => void;
  onSelect: () => void;
  onCancel: () => void;
}

function meter(level: ReasoningLevel, theme?: Theme): string {
  if (!level) return "\u2500\u2500\u2500\u2500\u2500";
  const index = REASONING_LEVELS.indexOf(level);
  const filled = index < 0 ? 0 : Math.min(index + 1, 5);
  return "\u25cf".repeat(filled) + "\u25cb".repeat(5 - filled);
}

export function ModelPicker({ state, theme, onMove, onReasoning, onSelect, onCancel }: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const rows = pickerRows(state.models, query);
  const visible = pickerWindow(rows, state.cursor, Math.max(3, Math.min(12, (process.stdout.rows || 24) - 10)));
  const search = (next: string) => {
    setQuery(next);
    const matches = pickerRows(state.models, next);
    if (matches.length && !matches.includes(state.cursor)) onMove(matches[0] - state.cursor);
  };
  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { if (rows.length) onSelect(); return; }
    if (key.upArrow) { onMove(movePicker(rows, state.cursor, -1) - state.cursor); return; }
    if (key.downArrow) { onMove(movePicker(rows, state.cursor, 1) - state.cursor); return; }
    if (key.leftArrow) { onReasoning(-1); return; }
    if (key.rightArrow) { onReasoning(1); return; }
    if (key.backspace || key.delete) { search(query.slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input)) search((query + input).slice(0, 100));
  });

  const accent = theme?.statusBar.accent ?? "cyan";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginTop={1}>
      <Box>
        <Text bold>Select model </Text>
        <Text dimColor>{"\u2191\u2193 navigate \u00b7 \u2190\u2192 reasoning \u00b7 enter select \u00b7 esc cancel"}</Text>
      </Box>
      <Text dimColor>Search: {query || "type to filter"} · {rows.length} models</Text>
      {!rows.length && <Text dimColor>No matching models.</Text>}
      {visible.map(i => {
        const model = state.models[i];
        const selected = i === state.cursor;
        return (
          <Text wrap="truncate-end" key={`${model.provider}/${model.id}`} color={selected ? accent : undefined} dimColor={!selected}>
            {selected ? "\u25b8 " : "  "}
            {model.label}
            <Text dimColor>{"  "}{meter(state.reasoning[i], theme)}{state.reasoning[i] ? ` ${state.reasoning[i]}` : ""}</Text>
            <Text dimColor>{"  "}{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : "? context"}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
