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
  theme?: Theme;
}

export function InputArea({ value, onChange, onSubmit, bashMode, focus, separatorColor, theme }: InputAreaProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns || 80;
  const sep = "\u2500".repeat(columns);
  const sepColor = theme?.input.separator ?? separatorColor ?? "gray";
  const promptColor = theme?.input.prompt ?? undefined;
  const bashPromptColor = theme?.input.bashPrompt ?? "yellow";

  return (
    <Box
      flexDirection="row"
      borderStyle="round"
      borderColor={sepColor}
      borderLeft={false}
      borderRight={false}
      borderTop={true}
      borderBottom={true}
      width={columns}
      marginTop={1}
    >
      {bashMode
        ? <Text color={bashPromptColor}>! </Text>
        : <Text color={promptColor} dimColor>{"\u276f"} </Text>
      }
      <PhrenInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        focus={focus}
      />
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
  running?: boolean;
  agents?: AgentTab[];
  selectedAgentId?: string | null;
  highlightedTabId?: string | null;
  tabFocused?: boolean;
}

const STATUS_ICON: Record<AgentTab["status"], string> = {
  running: "\u25cf",   // ●
  idle: "\u25cb",      // ○
  done: "\u2713",      // ✓
  error: "\u2717",     // ✗
  starting: "\u25cc",  // ◌
  cancelled: "\u2500", // ─
};

export function PermissionsLine({ mode, theme, running, agents, selectedAgentId, highlightedTabId, tabFocused }: PermissionsLineProps) {
  const icon = PERMISSION_ICONS[mode];
  const label = PERMISSION_LABELS[mode];
  const permColors = theme?.permission;
  const color = mode === "suggest"
    ? (permColors?.suggest ?? "")
    : mode === "auto-confirm"
      ? (permColors?.auto ?? "blue")
      : mode === "plan"
        ? ((permColors as Record<string, string> | undefined)?.plan ?? "magenta")
        : (permColors?.fullAuto ?? "green");

  const showPerm = mode !== "suggest";
  const hasAgents = agents && agents.length > 0;

  // Agent tab status → theme color
  const tabColors = theme?.agentTab;
  function agentTabColor(agent: AgentTab): string {
    if (tabColors) {
      if (agent.status === "running") return tabColors.running;
      if (agent.status === "idle") return tabColors.idle;
      if (agent.status === "done") return tabColors.done;
      if (agent.status === "error") return tabColors.error;
    }
    return agent.color;
  }

  return (
    <Box>
      {showPerm ? (
        <Text>{"  "}<Text color={color}>{icon} {label}</Text><Text dimColor> (shift+tab to cycle){running ? " \u00b7 esc to interrupt" : ""}</Text></Text>
      ) : (
        <Text>{"  "}{running ? <Text dimColor>esc to interrupt</Text> : null}</Text>
      )}
      {hasAgents ? (
        <Text>
          {"  "}
          {agents!.map((agent, i) => {
            const isActive = agent.id === selectedAgentId;
            const isHighlighted = tabFocused && agent.id === highlightedTabId;
            const statusIcon = STATUS_ICON[agent.status];
            const resolvedColor = agentTabColor(agent);
            return (
              <Text key={agent.id}>
                {i > 0 ? " " : ""}
                {isHighlighted
                  ? <Text bold inverse color={resolvedColor}>{` ${statusIcon} ${agent.name} `}</Text>
                  : isActive
                    ? <Text bold underline color={resolvedColor}>{statusIcon} {agent.name}</Text>
                    : <Text color={resolvedColor} dimColor={agent.status === "idle" || agent.status === "done"}>{statusIcon} {agent.name}</Text>
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
