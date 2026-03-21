/**
 * Legacy migration helpers for init: directory rename, skill rename.
 */
import * as fs from "fs";
import * as path from "path";
import { homePath } from "./shared.js";
import { hasInstallMarkers } from "./init-detect.js";

/**
 * Migrate the legacy hidden store directory into ~/.phren when upgrading
 * from the previous product name.
 * @returns true if migration occurred
 */
export function migrateLegacyStore(phrenPath: string, dryRun: boolean): boolean {
  const legacyPath = path.resolve(homePath(".cortex"));
  if (legacyPath === phrenPath || !fs.existsSync(legacyPath) || !hasInstallMarkers(legacyPath)) {
    return false;
  }
  if (!dryRun) {
    fs.renameSync(legacyPath, phrenPath);
  }
  console.log(`Migrated legacy store → ~/.phren`);
  return true;
}

/**
 * Rename stale legacy skill names left over from the rebrand.
 * Runs on every init so users who already migrated the directory still get the fix.
 */
export function migrateLegacySkills(phrenPath: string): void {
  const skillsMigrateDir = path.join(phrenPath, "global", "skills");
  if (!fs.existsSync(skillsMigrateDir)) return;

  const legacySkillName = "cortex.md";
  const legacySkillPrefix = "cortex-";
  for (const entry of fs.readdirSync(skillsMigrateDir)) {
    if (!entry.endsWith(".md")) continue;
    if (entry === legacySkillName) {
      const dest = path.join(skillsMigrateDir, "phren.md");
      if (!fs.existsSync(dest)) {
        fs.renameSync(path.join(skillsMigrateDir, entry), dest);
      }
    } else if (entry.startsWith(legacySkillPrefix)) {
      const newName = `phren-${entry.slice(legacySkillPrefix.length)}`;
      const dest = path.join(skillsMigrateDir, newName);
      if (!fs.existsSync(dest)) {
        fs.renameSync(path.join(skillsMigrateDir, entry), dest);
      }
    }
  }
}
