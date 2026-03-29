import React from "react";
import { Box, Text } from "ink";
import { PERMISSION_LABELS } from "../ansi.js";
import type { PermissionMode } from "../../permissions/types.js";

export interface StatusBarProps {
  provider: string;
  project: string | null;
  turns: number;
  cost: string;
  permMode?: PermissionMode;
  agentCount?: number;
}

export function StatusBar({ provider, project, turns, cost, permMode, agentCount }: StatusBarProps) {
  const modeLabel = permMode ? PERMISSION_LABELS[permMode] : "";
  const agentTag = agentCount && agentCount > 0 ? `A${agentCount}` : "";

  const leftParts = [" ◆ phren", provider];
  if (project) leftParts.push(project);
  const left = leftParts.join(" · ");

  const rightParts: string[] = [];
  if (modeLabel) rightParts.push(modeLabel);
  if (agentTag) rightParts.push(agentTag);
  if (cost) rightParts.push(cost);
  rightParts.push(`T${turns}`);
  const right = rightParts.join("  ") + " ";

  return (
    <Box width="100%">
      <Text inverse>{left}</Text>
      <Text inverse><Box flexGrow={1}><Text inverse> </Text></Box></Text>
      <Text inverse>{right}</Text>
    </Box>
  );
}
