import React from "react";
import { Box, Text } from "ink";
import * as os from "os";
import type { Theme } from "../themes.js";
import type { AppState } from "./App.js";

export interface BannerProps {
  state: AppState;
  theme?: Theme;
}

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M ctx`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k ctx`;
  return `${n} ctx`;
}

export function Banner({ state, theme }: BannerProps) {
  const cwd = process.cwd().replace(os.homedir(), "~");

  const logoColor = theme?.banner.logo ?? "magenta";
  const versionColor = theme?.banner.version ?? "gray";
  const cwdColor = theme?.banner.cwd ?? "cyan";

  const modelParts: string[] = [];
  if (state.model) modelParts.push(state.model);
  if (state.contextWindow) modelParts.push(formatContextWindow(state.contextWindow));
  if (state.reasoningEffort) modelParts.push(state.reasoningEffort);
  const modelLine = modelParts.join(" · ");

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* Line 1: brand + version */}
      <Box flexDirection="row">
        <Text bold color={logoColor}>{"◆ phren"}</Text>
        <Text color={versionColor} dimColor>{" v" + state.version}</Text>
      </Box>
      {/* Line 2: model info (only if available) */}
      {modelLine ? (
        <Text color={versionColor} dimColor>{modelLine}</Text>
      ) : null}
      {/* Line 3: cwd */}
      <Text color={cwdColor} dimColor>{cwd}</Text>
      <Text>{""}</Text>
    </Box>
  );
}
