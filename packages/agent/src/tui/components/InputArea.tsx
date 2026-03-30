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
}

export interface PermissionsLineProps {
  mode: PermissionMode;
  theme?: Theme;
  /** Active agent tabs for multi-agent mode */
  agents?: AgentTab[];
  /** Currently selected agent ID */
  selectedAgentId?: string | null;
}

const PERM_COLOR_MAP: Record<PermissionMode, string> = {
  "suggest": "cyan",
  "auto-confirm": "green",
  "full-auto": "yellow",
};

const AGENT_STATUS_ICON: Record<AgentTab["status"], string> = {
  running: "\u25cf",   // ●
  idle: "\u25cb",      // ○
  done: "\u2713",      // ✓
  error: "\u2717",     // ✗
  starting: "\u25cc",  // ◌
  cancelled: "\u2500", // ─
};

const AGENT_STATUS_COLOR: Record<AgentTab["status"], string> = {
  running: "green",
  idle: "gray",
  done: "cyan",
  error: "red",
  starting: "yellow",
  cancelled: "gray",
};

export function PermissionsLine({ mode, theme, agents, selectedAgentId }: PermissionsLineProps) {
  const icon = PERMISSION_ICONS[mode];
  const label = PERMISSION_LABELS[mode];
  const permColors = theme?.permission;
  const color = permColors
    ? (mode === "suggest" ? permColors.suggest : mode === "auto-confirm" ? permColors.auto : permColors.fullAuto)
    : PERM_COLOR_MAP[mode];

  const hasAgents = agents && agents.length > 0;

  return (
    <Box>
      <Text>
        {"  "}<Text color={color}>{icon} {label}</Text>
      </Text>
      {hasAgents ? (
        <Text>
          {"  \u2502 "}
          {agents!.map((agent, i) => {
            const isSelected = agent.id === selectedAgentId;
            const statusIcon = AGENT_STATUS_ICON[agent.status];
            const statusColor = AGENT_STATUS_COLOR[agent.status];
            const nameText = `${statusIcon} ${agent.name}`;
            return (
              <Text key={agent.id}>
                {i > 0 ? "  " : ""}
                {isSelected
                  ? <Text bold inverse color={statusColor}>{` ${nameText} `}</Text>
                  : <Text color={statusColor}>{nameText}</Text>
                }
              </Text>
            );
          })}
          <Text dimColor>{"  (1-9 switch)"}</Text>
        </Text>
      ) : (
        <Text dimColor>{" \u00b7 shift+tab toggle \u00b7 esc to interrupt"}</Text>
      )}
    </Box>
  );
}
