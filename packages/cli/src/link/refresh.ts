/** Refresh existing managed context destinations after a store pull, without relinking the installation. */
import * as fs from "fs";
import * as path from "path";
import { homePath } from "../phren-paths.js";
import { getProjectDirs } from "../shared.js";
import { readProjectConfig, getProjectSourcePath, getProjectOwnershipMode } from "../project-config.js";
import { findProjectDir } from "../project-locator.js";
import { resolveManagementCapabilities } from "../init/management-preset.js";
import { syncScopeSkillsToDir } from "../skill/files.js";
import { getNonPrimaryStores, getStoreProjectDirs } from "../store-registry.js";

/**
 * Projects from attached team stores whose checkout is on this machine. Profiles
 * list only the primary store's projects, so link and refresh reach these here;
 * a project the primary store also has is left to the primary.
 */
export function teamStoreProjectCheckouts(phrenPath: string): Array<{ project: string; target: string; skills: boolean }> {
  const found: Array<{ project: string; target: string; skills: boolean }> = [];
  const seen = new Set<string>();
  for (const store of getNonPrimaryStores(phrenPath)) {
    if (!fs.existsSync(store.path)) continue;
    for (const dir of getStoreProjectDirs(store)) {
      const project = path.basename(dir);
      if (project === "global" || seen.has(project) || fs.existsSync(path.join(phrenPath, project))) continue;
      seen.add(project);
      const config = readProjectConfig(store.path, project);
      if (getProjectOwnershipMode(store.path, project, config) !== "phren-managed") continue;
      // The store is shared between computers, so its sourcePath may be another machine's.
      const configured = getProjectSourcePath(store.path, project, config);
      const target = configured && fs.existsSync(configured) ? configured : findProjectDir(project);
      if (target && fs.existsSync(target)) found.push({ project, target, skills: config.skills !== false });
    }
  }
  return found;
}

export function refreshLinkedContext(phrenPath: string, profile: string): void {
  const caps = resolveManagementCapabilities(phrenPath);
  if (caps.installSkillLinks) {
    for (const tool of [".claude", ".agents", ".copilot"]) {
      const dir = homePath(tool, "skills");
      if (fs.existsSync(path.join(path.dirname(dir), "skill-manifest.json"))) syncScopeSkillsToDir(phrenPath, "global", dir);
    }
  }
  if (!caps.repoMirroring) return;
  for (const source of getProjectDirs(phrenPath, profile)) {
    const project = path.basename(source);
    if (project === "global") continue;
    const config = readProjectConfig(phrenPath, project);
    if (getProjectOwnershipMode(phrenPath, project, config) !== "phren-managed") continue;
    const target = getProjectSourcePath(phrenPath, project, config) ?? findProjectDir(project);
    if (!target || !fs.existsSync(target)) continue;
    const skillsDir = path.join(target, ".claude", "skills");
    if (config.skills !== false && fs.existsSync(path.join(target, ".claude", "skill-manifest.json"))) {
      syncScopeSkillsToDir(phrenPath, project, skillsDir);
    }
    const agentsPath = path.join(target, "AGENTS.md");
    const claudePath = path.join(source, "AGENTS.md");
    // Older releases wrote AGENTS.md as a generated snapshot with a skills table;
    // link and doctor --fix replace that with a symlink to the store's AGENTS.md.
    // Do the same here instead of regenerating the snapshot, or a pull and a
    // doctor run keep flipping the file between the two shapes.
    if (!fs.existsSync(agentsPath) || !fs.existsSync(claudePath) || fs.lstatSync(agentsPath).isSymbolicLink()) continue;
    if (!fs.readFileSync(agentsPath, "utf8").includes("<!-- phren:generated-agents -->")) continue;
    fs.unlinkSync(agentsPath);
    fs.symlinkSync(claudePath, agentsPath);
  }
  for (const { project, target, skills } of teamStoreProjectCheckouts(phrenPath)) {
    if (skills && fs.existsSync(path.join(target, ".claude", "skill-manifest.json"))) {
      syncScopeSkillsToDir(phrenPath, project, path.join(target, ".claude", "skills"));
    }
  }
}
