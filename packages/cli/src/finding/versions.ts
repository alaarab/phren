import * as crypto from "crypto";
import * as fs from "fs";
import { isCitationLine } from "../content/metadata.js";

/** Hash stored bullets and citations, including every lifecycle/provenance comment. */
export function readFindingVersions(file: string): Record<string, string> {
  let lines: string[];
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { return {}; }
  const versions: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const fid = /^- .*<!--\s*fid:([a-f0-9]{8})\s*-->/.exec(lines[i])?.[1];
    if (fid) versions[fid] = crypto.createHash("sha256").update(lines[i] + (isCitationLine(lines[i + 1] ?? "") ? `\n${lines[i + 1]}` : "")).digest("hex");
  }
  return versions;
}

/** Called under the writer's findings lock, immediately before mutation. */
export function assertFindingVersions(file: string, expected?: Record<string, string>): void {
  if (!expected) return;
  const current = readFindingVersions(file);
  if (Object.entries(expected).some(([fid, version]) => !version || current[fid] !== version)) throw new Error("target finding missing or changed since the run");
}
