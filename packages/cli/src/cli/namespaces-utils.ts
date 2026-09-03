import * as fs from "fs";
import * as path from "path";
import { logger } from "../logger.js";
import { openInEditor as launchEditor } from "../editor/launch.js";
import { getNonPrimaryStores } from "../store-registry.js";

export function resolveProjectStorePath(phrenPath: string, project: string): string {
  try {
    if (fs.existsSync(path.join(phrenPath, project))) return phrenPath;
    for (const store of getNonPrimaryStores(phrenPath)) {
      if (fs.existsSync(path.join(store.path, project))) return store.path;
    }
  } catch { /* fall through */ }
  return phrenPath;
}

export function parseMcpToggle(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "enabled") return true;
  if (normalized === "off" || normalized === "false" || normalized === "disabled") return false;
  return undefined;
}

/**
 * One-shot CLI wrapper around the shared launcher: exits non-zero when the
 * editor will not start, which is right for a command and wrong inside the
 * shell — hence the split.
 */
export function openInEditor(filePath: string): void {
  const result = launchEditor(filePath);
  if (result.ok) return;
  logger.debug("cli-namespaces", `openInEditor: ${result.error ?? "failed"}`);
  console.error(`Editor "${result.command}" failed. Set $EDITOR to your preferred editor.`);
  process.exit(1);
}
