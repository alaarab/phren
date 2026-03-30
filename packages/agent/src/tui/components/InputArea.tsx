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
  /** Color from agent-colors palette */
  color: string;
}

export interface PermissionsLineProps {
  mode: PermissionMode;
  theme?: Theme;
  /** Active agent tabs for multi-agent mode */
  agents?: AgentTab[];
  /** Currently active agent (whose thread is shown) */
  selectedAgentId?: string | null;
  /** Currently highlighted tab in tab-navigation mode (null = not in tab mode) */
  highlightedTabId?: string | null;
  /** Whether the tab bar has focus (user navigating with arrows) */
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

  const hasAgents = agents && agents.length > 0;
  const showPerm = mode !== "suggest"; // ask mode shows nothing

  return (
    <Box>
      {showPerm ? (
        <Text>
          {"  "}<Text color={color}>{icon} {label}</Text>
        </Text>
      ) : (
        <Text>{"  "}</Text>
      )}
      {hasAgents ? (
        <Text>
          {"  \u2502 "}
          {agents!.map((agent, i) => {
            const isActive = agent.id === selectedAgentId;
            const isHighlighted = tabFocused && agent.id === highlightedTabId;
            const statusIcon = STATUS_ICON[agent.status];
            const nameText = `${statusIcon} ${agent.name}`;
            return (
              <Text key={agent.id}>
                {i > 0 ? " " : ""}
                {isHighlighted
                  ? <Text bold inverse color={agent.color}>{` ${nameText} `}</Text>
                  : isActive
                    ? <Text bold underline color={agent.color}>{nameText}</Text>
                    : <Text color={agent.color}>{nameText}</Text>
                }
              </Text>
            );
          })}
          {tabFocused
            ? <Text dimColor>{"  \u2190\u2192 navigate \u00b7 enter select \u00b7 \u2191 back"}</Text>
            : <Text dimColor>{"  \u2193 agents"}</Text>
          }
        </Text>
      ) : (
        <Text dimColor>{" \u00b7 shift+tab toggle \u00b7 esc to interrupt"}</Text>
      )}
    </Box>
  );
}
