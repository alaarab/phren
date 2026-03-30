import React from "react";
import { Box, Text } from "ink";
import * as os from "os";
import { createRequire } from "module";
import type { Theme } from "../themes.js";

const _require = createRequire(import.meta.url);

export interface BannerProps {
  version: string;
  theme?: Theme;
}

let cachedArt: string[] | null = null;
let artLoaded = false;

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

export function Banner({ version, theme }: BannerProps) {
  const cwd = process.cwd().replace(os.homedir(), "~");
  const artLines = getArtLines();
  const maxArtWidth = 26;

  const logoColor = theme?.banner.logo ?? "magenta";
  const versionColor = theme?.banner.version ?? "gray";
  const cwdColor = theme?.banner.cwd ?? "cyan";

  const infoLines = [
    { key: "title", node: <Text bold color={logoColor}>{"◆ phren"}</Text> },
    { key: "version", node: <Text color={versionColor} dimColor>{"  v" + version}</Text> },
    { key: "cwd", node: <Text color={cwdColor} dimColor>{cwd}</Text> },
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
          return (
            <Box key={i} flexDirection="row">
              <Text>{artLine + " ".repeat(padding)}</Text>
              {info ? info.node : <Text>{""}</Text>}
            </Box>
          );
        })}
        <Text>{""}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>{infoLines[0].node}{infoLines[1].node}</Box>
      {infoLines[2].node}
      <Text>{""}</Text>
    </Box>
  );
}
