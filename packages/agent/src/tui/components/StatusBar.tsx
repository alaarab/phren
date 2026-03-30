import React from "react";
import { Box, Text, useStdout } from "ink";
import { PERMISSION_LABELS } from "../ansi.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { Theme } from "../themes.js";

export interface StatusBarProps {
  provider: string;
  project: string | null;
  turns: number;
  cost: string;
  permMode?: PermissionMode;
  agentCount?: number;
  theme?: Theme;
}

export function StatusBar({ provider, project, turns, cost, permMode, agentCount, theme }: StatusBarProps) {
  const { stdout } = useStdout();
  const width = stdout?.columns || 80;
  const modeLabel = permMode ? PERMISSION_LABELS[permMode] : "";
  const agentTag = agentCount && agentCount > 0 ? `A${agentCount}` : "";

  const leftParts = [" \u25c6 phren", provider];
  if (project) leftParts.push(project);
  const left = leftParts.join(" \u00b7 ");

  const rightParts: string[] = [];
  if (modeLabel) rightParts.push(modeLabel);
  if (agentTag) rightParts.push(agentTag);
  if (cost) rightParts.push(cost);
  rightParts.push(`T${turns}`);
  const right = rightParts.join("  ") + " ";

  const pad = Math.max(0, width - left.length - right.length);
  const fullLine = left + " ".repeat(pad) + right;

  // theme.statusBar.accent is available for future use (e.g. highlighted segments)
  const _accent = theme?.statusBar.accent;

  return <Text inverse>{fullLine}</Text>;
}
