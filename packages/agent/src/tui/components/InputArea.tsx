import React from "react";
import { Box, Text, useStdout } from "ink";
import { PhrenInput } from "./PhrenInput.js";
import { PERMISSION_LABELS, PERMISSION_ICONS } from "../ansi.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { Theme } from "../themes.js";

export interface InputAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  bashMode: boolean;
  focus: boolean;
  separatorColor?: string;
}

export function InputArea({ value, onChange, onSubmit, bashMode, focus, separatorColor }: InputAreaProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns || 80;
  const sep = "\u2500".repeat(columns);
  const sepColor = separatorColor ?? "gray";

  return (
    <Box flexDirection="column">
      <Text color={sepColor} dimColor>{sep}</Text>
      <Box>
        {bashMode
          ? <Text color="yellow">! </Text>
          : <Text dimColor>{"\u25b8"} </Text>
        }
        <PhrenInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focus}
        />
      </Box>
      <Text color={sepColor} dimColor>{sep}</Text>
    </Box>
  );
}

export interface PermissionsLineProps {
  mode: PermissionMode;
  theme?: Theme;
}

const PERM_COLOR_MAP: Record<PermissionMode, string> = {
  "suggest": "cyan",
  "auto-confirm": "green",
  "full-auto": "yellow",
};

export function PermissionsLine({ mode, theme }: PermissionsLineProps) {
  const icon = PERMISSION_ICONS[mode];
  const label = PERMISSION_LABELS[mode];
  const permColors = theme?.permission;
  const color = permColors
    ? (mode === "suggest" ? permColors.suggest : mode === "auto-confirm" ? permColors.auto : permColors.fullAuto)
    : PERM_COLOR_MAP[mode];

  return (
    <Text>
      {"  "}<Text color={color}>{icon} {label} permissions</Text>{" "}
      <Text dimColor>(shift+tab toggle {"\u00b7"} esc to interrupt)</Text>
    </Text>
  );
}
