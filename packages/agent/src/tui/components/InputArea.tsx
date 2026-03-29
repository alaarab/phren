import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { PERMISSION_LABELS, PERMISSION_ICONS, PERMISSION_COLORS } from "../ansi.js";
import type { PermissionMode } from "../../permissions/types.js";

export interface InputAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  bashMode: boolean;
  focus: boolean;
}

export function InputArea({ value, onChange, onSubmit, bashMode, focus }: InputAreaProps) {
  const sep = "─".repeat(process.stdout.columns || 80);

  return (
    <Box flexDirection="column">
      <Text dimColor>{sep}</Text>
      <Box>
        {bashMode
          ? <Text color="yellow">! </Text>
          : <Text dimColor>▸ </Text>
        }
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focus}
          showCursor
        />
      </Box>
      <Text dimColor>{sep}</Text>
    </Box>
  );
}

export interface PermissionsLineProps {
  mode: PermissionMode;
}

export function PermissionsLine({ mode }: PermissionsLineProps) {
  const colorFn = PERMISSION_COLORS[mode];
  const icon = PERMISSION_ICONS[mode];
  const label = PERMISSION_LABELS[mode];
  // Apply ANSI color to the permission tag text
  const tag = colorFn(`${icon} ${label} permissions`);

  return (
    <Text>
      {"  "}<Text>{tag}</Text> <Text dimColor>(shift+tab toggle · esc to interrupt)</Text>
    </Text>
  );
}
