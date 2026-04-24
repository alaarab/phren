import * as fs from "fs";
import * as path from "path";
import { listInvalidProjectDirs, normalizeProjectNameForCreate } from "./phren-paths.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import {
  listProfiles,
  addProjectToProfile,
  removeProjectFromProfile,
} from "./profile-store.js";
import { logger } from "./logger.js";

export type MigrationOutcome =
  | { from: string; to: string; action: "renamed" }
  | { from: string; to: string; action: "skipped-collision"; reason: string }
  | { from: string; to: string; action: "skipped-invalid-slug"; reason: string }
  | { from: string; to: string; action: "error"; reason: string };

export interface MigrationResult {
  outcomes: MigrationOutcome[];
}

// Rename on-disk project directories whose names fail `isValidProjectName`
// (typically uppercase) to their lowercase form, and update any profile YAML
// references. Skips entries where the target name would collide with an
// existing directory or where lowercasing alone doesn't yield a valid name.
export function migrateInvalidProjectNames(phrenPath: string): MigrationResult {
  const invalid = listInvalidProjectDirs(phrenPath);
  const outcomes: MigrationOutcome[] = [];

  for (const from of invalid) {
    const to = normalizeProjectNameForCreate(from);

    if (!isValidProjectName(to)) {
      outcomes.push({
        from,
        to,
        action: "skipped-invalid-slug",
        reason: `lowercasing does not yield a valid name (got "${to}"); rename manually`,
      });
      continue;
    }

    if (to === from) {
      outcomes.push({
        from,
        to,
        action: "skipped-invalid-slug",
        reason: "already lowercase but still fails validation; rename manually",
      });
      continue;
    }

    const oldDir = path.join(phrenPath, from);
    const newDir = path.join(phrenPath, to);

    // Case-insensitive filesystems (macOS APFS/HFS+, default Windows) resolve
    // both paths to the same inode. Treat that as "rename casing in place"
    // rather than a collision.
    let sameInode = false;
    try {
      if (fs.existsSync(newDir)) {
        const oldStat = fs.statSync(oldDir);
        const newStat = fs.statSync(newDir);
        sameInode = oldStat.ino === newStat.ino && oldStat.dev === newStat.dev;
      }
    } catch (err: unknown) {
      logger.debug("project-migrate", `stat compare ${from}->${to}: ${errorMessage(err)}`);
    }

    if (fs.existsSync(newDir) && !sameInode) {
      outcomes.push({
        from,
        to,
        action: "skipped-collision",
        reason: `target "${to}" already exists as a separate directory; merge manually`,
      });
      continue;
    }

    try {
      if (sameInode) {
        // Two-step rename forces the case change on case-insensitive filesystems
        // without letting an observer see a missing directory.
        const tmp = path.join(phrenPath, `${from}.phren-case-tmp-${process.pid}`);
        fs.renameSync(oldDir, tmp);
        fs.renameSync(tmp, newDir);
      } else {
        fs.renameSync(oldDir, newDir);
      }
    } catch (err: unknown) {
      outcomes.push({
        from,
        to,
        action: "error",
        reason: `rename failed: ${errorMessage(err)}`,
      });
      continue;
    }

    updateProfileReferences(phrenPath, from, to);

    outcomes.push({ from, to, action: "renamed" });
  }

  return { outcomes };
}

function updateProfileReferences(phrenPath: string, oldName: string, newName: string): void {
  const profiles = listProfiles(phrenPath);
  if (!profiles.ok) {
    logger.debug("project-migrate", `updateProfileReferences listProfiles: ${profiles.error}`);
    return;
  }
  for (const profile of profiles.data) {
    if (!profile.projects.includes(oldName)) continue;
    const removed = removeProjectFromProfile(phrenPath, profile.name, oldName);
    if (!removed.ok) {
      logger.debug("project-migrate", `remove ${oldName} from ${profile.name}: ${removed.error}`);
      continue;
    }
    const added = addProjectToProfile(phrenPath, profile.name, newName);
    if (!added.ok) {
      logger.debug("project-migrate", `add ${newName} to ${profile.name}: ${added.error}`);
    }
  }
}

export function formatMigrationSummary(result: MigrationResult): string {
  if (result.outcomes.length === 0) return "no invalid project directories found";
  const parts: string[] = [];
  const renamed = result.outcomes.filter((o) => o.action === "renamed");
  const collisions = result.outcomes.filter((o) => o.action === "skipped-collision");
  const invalidSlugs = result.outcomes.filter((o) => o.action === "skipped-invalid-slug");
  const errors = result.outcomes.filter((o) => o.action === "error");
  if (renamed.length > 0) {
    parts.push(`renamed ${renamed.length}: ${renamed.map((o) => `${o.from}->${o.to}`).join(", ")}`);
  }
  if (collisions.length > 0) {
    parts.push(`${collisions.length} collision(s): ${collisions.map((o) => o.from).join(", ")}`);
  }
  if (invalidSlugs.length > 0) {
    parts.push(`${invalidSlugs.length} unfixable: ${invalidSlugs.map((o) => o.from).join(", ")}`);
  }
  if (errors.length > 0) {
    parts.push(`${errors.length} error(s): ${errors.map((o) => `${o.from} (${o.reason})`).join(", ")}`);
  }
  return parts.join("; ");
}
