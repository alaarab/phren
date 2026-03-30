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

export interface AgentTab {
  id: string;
  name: string;
  status: "running" | "idle" | "done" | "error" | "starting" | "cancelled";
  color: string;
}

export interface PermissionsLineProps {
  mode: PermissionMode;
  theme?: Theme;
  agents?: AgentTab[];
  selectedAgentId?: string | null;
  highlightedTabId?: string | null;
  tabFocused?: boolean;
}

const PERM_COLOR_MAP: Record<PermissionMode, string> = {
  "suggest": "",
  "auto-confirm": "yellow",
  "plan": "magenta",
  "full-auto": "green",
};

const STATUS_ICON: Record<AgentTab["status"], string> = {
  running: "\u25cf",   // ●
  idle: "\u25cb",      // ○
  done: "\u2713",      // ✓
  error: "\u2717",     // ✗
  starting: "\u25cc",  // ◌
  cancelled: "\u2500", // ─
};

export function PermissionsLine({ mode, theme, agents, selectedAgentId, highlightedTabId, tabFocused }: PermissionsLineProps) {
  const icon = PERMISSION_ICONS[mode];
  const label = PERMISSION_LABELS[mode];
  const permColors = theme?.permission;
  const color = permColors
    ? (mode === "suggest" ? permColors.suggest : mode === "auto-confirm" ? permColors.auto : mode === "plan" ? (permColors as Record<string, string>).plan ?? "magenta" : permColors.fullAuto)
    : PERM_COLOR_MAP[mode];

  const showPerm = mode !== "suggest";
  const hasAgents = agents && agents.length > 0;

  return (
    <Box>
      {showPerm ? (
        <Text>{"  "}<Text color={color}>{icon} {label}</Text></Text>
      ) : (
        <Text>{"  "}</Text>
      )}
      {hasAgents ? (
        <Text>
          {"  "}
          {agents!.map((agent, i) => {
            const isActive = agent.id === selectedAgentId;
            const isHighlighted = tabFocused && agent.id === highlightedTabId;
            const statusIcon = STATUS_ICON[agent.status];
            return (
              <Text key={agent.id}>
                {i > 0 ? " " : ""}
                {isHighlighted
                  ? <Text bold inverse color={agent.color}>{` ${statusIcon} ${agent.name} `}</Text>
                  : isActive
                    ? <Text bold underline color={agent.color}>{statusIcon} {agent.name}</Text>
                    : <Text color={agent.color} dimColor={agent.status === "idle" || agent.status === "done"}>{statusIcon} {agent.name}</Text>
                }
              </Text>
            );
          })}
          {tabFocused
            ? <Text dimColor>{"  \u2190\u2192 enter \u2191 back"}</Text>
            : <Text dimColor>{"  \u2193"}</Text>
          }
        </Text>
      ) : null}
    </Box>
  );
}
