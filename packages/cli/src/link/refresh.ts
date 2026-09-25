/** Refresh existing managed context destinations after a store pull, without relinking the installation. */
import * as fs from "fs";
import * as path from "path";
import { homePath } from "../phren-paths.js";
import { getProjectDirs } from "../shared.js";
import { readProjectConfig, getProjectSourcePath, getProjectOwnershipMode } from "../project-config.js";
import { findProjectDir } from "../project-locator.js";
import { resolveManagementCapabilities } from "../init/management-preset.js";
import { syncScopeSkillsToDir } from "../skill/files.js";

export function refreshLinkedContext(phrenPath: string, profile: string): void {
  const caps = resolveManagementCapabilities(phrenPath);
  if (caps.installSkillLinks) {
    for (const tool of [".claude", ".copilot"]) {
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
}
