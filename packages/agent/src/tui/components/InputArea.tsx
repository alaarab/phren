import React from "react";
import { Box, Text, useStdout } from "ink";
import TextInput from "ink-text-input";
import { PERMISSION_LABELS, PERMISSION_ICONS } from "../ansi.js";
import type { PermissionMode } from "../../permissions/types.js";

export interface InputAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  bashMode: boolean;
  focus: boolean;
}

export function InputArea({ value, onChange, onSubmit, bashMode, focus }: InputAreaProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns || 80;
  const sep = "\u2500".repeat(columns);

  return (
    <Box flexDirection="column">
      <Text dimColor>{sep}</Text>
      <Box>
        {bashMode
          ? <Text color="yellow">! </Text>
          : <Text dimColor>{"\u25b8"} </Text>
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

const PERM_COLOR_MAP: Record<PermissionMode, string> = {
  "suggest": "cyan",
  "auto-confirm": "green",
  "full-auto": "yellow",
};

export function PermissionsLine({ mode }: PermissionsLineProps) {
  const icon = PERMISSION_ICONS[mode];
  const label = PERMISSION_LABELS[mode];
  const color = PERM_COLOR_MAP[mode];

  return (
    <Text>
      {"  "}<Text color={color}>{icon} {label} permissions</Text>{" "}
      <Text dimColor>(shift+tab toggle {"\u00b7"} esc to interrupt)</Text>
    </Text>
  );
}
