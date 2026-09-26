import { Box, Text, useInput } from "ink";
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
  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { onSelect(); return; }
    if (key.upArrow) { onMove(-1); return; }
    if (key.downArrow) { onMove(1); return; }
    if (key.leftArrow) { onReasoning(-1); return; }
    if (key.rightArrow) { onReasoning(1); return; }
  });

  const accent = theme?.statusBar.accent ?? "cyan";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginTop={1}>
      <Box>
        <Text bold>Select model </Text>
        <Text dimColor>{"\u2191\u2193 navigate \u00b7 \u2190\u2192 reasoning \u00b7 enter select \u00b7 esc cancel"}</Text>
      </Box>
      {state.models.map((model, i) => {
        const selected = i === state.cursor;
        return (
          <Text key={model.id} color={selected ? accent : undefined} dimColor={!selected}>
            {selected ? "\u25b8 " : "  "}
            {model.label}
            <Text dimColor>{"  "}{meter(state.reasoning[i], theme)}{state.reasoning[i] ? ` ${state.reasoning[i]}` : ""}</Text>
            <Text dimColor>{"  "}{Math.round(model.contextWindow / 1000)}k</Text>
          </Text>
        );
      })}
    </Box>
  );
}
