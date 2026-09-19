import { Box, Text, useStdout } from "ink";
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

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (displayWidth(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (displayWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + "\u2026";
}

export function StatusBar({ provider, model, project, turns, cost, contextTokens, contextLimit, reasoningEffort, theme }: StatusBarProps) {
  const { stdout } = useStdout();
  const width = stdout?.columns || 80;
  const leftParts = ["\u25c6 phren", provider];
  if (model) leftParts.push(model);
  if (project) leftParts.push(project);
  const left = leftParts.join(" \u00b7 ");

  const pct = contextTokens !== undefined && contextLimit && contextLimit > 0
    ? Math.round((contextTokens / contextLimit) * 100)
    : undefined;
  const ctxText = pct !== undefined ? `ctx ${pct}%` : "";
  const restParts: string[] = [];
  if (reasoningEffort) restParts.push(reasoningEffort);
  if (cost) restParts.push(cost);
  restParts.push(`T${turns}`);
  const rest = restParts.join(" \u00b7 ");

  const rightWidth = displayWidth(ctxText) + (ctxText && rest ? 3 : 0) + displayWidth(rest);
  const leftText = truncate(left, Math.max(0, width - rightWidth - 2));
  const pad = Math.max(1, width - displayWidth(leftText) - rightWidth - 1);
  const hot = pct !== undefined && pct >= 80;

  return (
    <Box>
      <Text dimColor color={theme?.statusBar.accent}>{leftText + " ".repeat(pad)}</Text>
      {ctxText ? <Text color={hot ? "yellow" : undefined} dimColor={!hot}>{ctxText}</Text> : null}
      {ctxText && rest ? <Text dimColor>{" \u00b7 "}</Text> : null}
      {rest ? <Text dimColor>{rest}</Text> : null}
    </Box>
  );
}
