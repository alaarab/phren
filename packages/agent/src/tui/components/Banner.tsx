import React from "react";
import { Box, Text } from "ink";
import * as os from "os";
import type { PermissionMode } from "../../permissions/types.js";
import { PERMISSION_ICONS, PERMISSION_COLORS } from "../ansi.js";

export interface BannerProps {
  provider: string;
  project: string | null;
  version: string;
  permissionMode: PermissionMode;
}

let cachedArt: string[] | null = null;
let artLoaded = false;

import { createRequire } from "module";
const _require = createRequire(import.meta.url);

function getArtLines(): string[] {
  if (artLoaded) return cachedArt ?? [];
  artLoaded = true;
  try {
    const mod = _require("@phren/cli/phren-art") as { PHREN_ART: string[] };
    cachedArt = mod.PHREN_ART.filter((l: string) => l.trim());
    return cachedArt;
  } catch {
    return [];
  }
}

function stripAnsi(t: string): string {
  return t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function PermTag({ mode }: { mode: PermissionMode }) {
  const icon = PERMISSION_ICONS[mode];
  const colorFn = PERMISSION_COLORS[mode];
  // Ink doesn't support arbitrary ANSI, so map mode to Ink color names
  const colorMap: Record<PermissionMode, string> = {
    "suggest": "cyan",
    "auto-confirm": "green",
    "full-auto": "yellow",
  };
  const color = colorMap[mode];
  // colorFn is only used for raw ANSI; for Ink we use the color prop
  void colorFn;
  return <Text color={color}>{icon} {mode}</Text>;
}

export function Banner({ provider, project, version, permissionMode }: BannerProps) {
  const cwd = process.cwd().replace(os.homedir(), "~");
  const artLines = getArtLines();
  const maxArtWidth = 26;

  const infoLines = [
    { key: "title", node: <Text bold color="magenta">{"◆ phren agent"}</Text> },
    { key: "version", node: <Text dimColor>{"  v" + version}</Text> },
    { key: "provider", node: <Text dimColor>{provider}{project ? ` · ${project}` : ""}</Text> },
    { key: "cwd", node: <Text dimColor>{cwd}</Text> },
    { key: "spacer1", node: <Text>{""}</Text> },
    { key: "perms", node: <Box><PermTag mode={permissionMode} /><Text dimColor> permissions (shift+tab toggle · esc to interrupt)</Text></Box> },
    { key: "spacer2", node: <Text>{""}</Text> },
    { key: "shortcuts", node: <Text dimColor><Text>Tab</Text> memory  <Text>Shift+Tab</Text> perms  <Text>/help</Text> cmds  <Text>Ctrl+D</Text> exit</Text> },
  ];

  if (artLines.length > 0) {
    const rowCount = Math.max(artLines.length, infoLines.length);
    return (
      <Box flexDirection="column">
        {Array.from({ length: rowCount }, (_, i) => {
          const artLine = i < artLines.length ? artLines[i] : "";
          const artVisible = stripAnsi(artLine).length;
          const padding = Math.max(0, maxArtWidth - artVisible);
          const info = i < infoLines.length ? infoLines[i] : null;
          // Combine the raw ANSI art line with the Ink info node
          // We use a raw write for art since it contains truecolor ANSI
          return (
            <Box key={i} flexDirection="row">
              <Text>{artLine + " ".repeat(padding)}</Text>
              {info ? info.node : <Text>{""}</Text>}
            </Box>
          );
        })}
      </Box>
    );
  }

  // No art fallback: just info lines
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        {infoLines[0].node}
        {infoLines[1].node}
      </Box>
      <Box>
        {infoLines[2].node}
        <Text>{"  "}</Text>
        {infoLines[3].node}
      </Box>
      {infoLines[5].node}
      <Text>{""}</Text>
      {infoLines[7].node}
    </Box>
  );
}
