import { Text, useStdout } from "ink";
import type { Theme } from "../themes.js";

export interface StatusBarProps {
  provider: string;
  model?: string;
  project: string | null;
  turns: number;
  cost: string;
  contextTokens?: number;
  contextLimit?: number;
  reasoningEffort?: string;
  theme?: Theme;
}

export function StatusBar({ provider, model, project, turns, cost, contextTokens, contextLimit, reasoningEffort, theme }: StatusBarProps) {
  const { stdout } = useStdout();
  const width = stdout?.columns || 80;
  const leftParts = ["\u25c6 phren", provider];
  if (model) leftParts.push(model);
  if (project) leftParts.push(project);
  let left = leftParts.join(" \u00b7 ");

  const rightParts: string[] = [];
  if (contextTokens !== undefined && contextLimit && contextLimit > 0) {
    rightParts.push(`ctx ${Math.round((contextTokens / contextLimit) * 100)}%`);
  }
  if (reasoningEffort) rightParts.push(reasoningEffort);
  if (cost) rightParts.push(cost);
  rightParts.push(`T${turns}`);
  const right = rightParts.join(" \u00b7 ");

  const available = Math.max(0, width - right.length - 3);
  if (left.length > available) left = available > 1 ? left.slice(0, available - 1) + "\u2026" : "";
  const pad = Math.max(1, width - left.length - right.length);
  return <Text dimColor color={theme?.statusBar.accent}>{left + " ".repeat(pad) + right}</Text>;
}
