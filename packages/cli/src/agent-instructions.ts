import * as fs from "fs";
import * as path from "path";
import { atomicWriteText, debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";

export const AGENT_INSTRUCTIONS_FILENAME = "AGENTS.md";
export const LEGACY_AGENT_INSTRUCTIONS_FILENAME = "CLAUDE.md";

/** Resolve instructions without changing the store. New files always win. */
export function resolveAgentInstructionsPath(scopeDir: string): string | null {
  const canonical = path.join(scopeDir, AGENT_INSTRUCTIONS_FILENAME);
  if (fs.existsSync(canonical)) return canonical;
  const legacy = path.join(scopeDir, LEGACY_AGENT_INSTRUCTIONS_FILENAME);
  return fs.existsSync(legacy) ? legacy : null;
}

/**
 * Copy legacy instructions to AGENTS.md once. The legacy source is retained so
 * an interrupted upgrade, older Phren client, or hand-written Claude setup
 * cannot lose data. When both files exist AGENTS.md remains authoritative and
 * neither file is modified.
 */
export function migrateLegacyAgentInstructions(scopeDir: string): boolean {
  const canonical = path.join(scopeDir, AGENT_INSTRUCTIONS_FILENAME);
  const legacy = path.join(scopeDir, LEGACY_AGENT_INSTRUCTIONS_FILENAME);
  if (fs.existsSync(canonical) || !fs.existsSync(legacy)) return false;
  try {
    atomicWriteText(canonical, fs.readFileSync(legacy, "utf8"));
    return true;
  } catch (err: unknown) {
    debugLog(`agent instructions migration failed for ${scopeDir}: ${errorMessage(err)}`);
    return false;
  }
}

export function migrateStoreAgentInstructions(phrenPath: string): string[] {
  const migrated: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(phrenPath, { withFileTypes: true }); } catch { return migrated; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const scopeDir = path.join(phrenPath, entry.name);
    if (migrateLegacyAgentInstructions(scopeDir)) migrated.push(`${entry.name}/${AGENT_INSTRUCTIONS_FILENAME}`);
  }
  return migrated;
}
