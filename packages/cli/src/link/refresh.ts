/** Refresh existing managed context destinations after a store pull, without relinking the installation. */
import * as fs from "fs";
import * as path from "path";
import { atomicWriteText, homePath } from "../phren-paths.js";
import { getProjectDirs } from "../shared.js";
import { readProjectConfig, getProjectSourcePath, getProjectOwnershipMode } from "../project-config.js";
import { findProjectDir } from "../project-locator.js";
import { resolveManagementCapabilities } from "../init/management-preset.js";
import { syncScopeSkillsToDir } from "../skill/files.js";
import { buildSkillManifest, renderSkillInstructionsSection } from "../skill/registry.js";

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
    const manifest = config.skills !== false && fs.existsSync(path.join(target, ".claude", "skill-manifest.json"))
      ? syncScopeSkillsToDir(phrenPath, project, skillsDir)
      : buildSkillManifest(phrenPath, profile, project);
    const agentsPath = path.join(target, "AGENTS.md");
    const claudePath = path.join(source, "CLAUDE.md");
    // The generated file is a snapshot, unlike the live CLAUDE.md symlink.
    // Preserve native/user-owned instructions and installations without a Codex mirror.
    if (!fs.existsSync(agentsPath) || !fs.existsSync(claudePath) || fs.lstatSync(agentsPath).isSymbolicLink()) continue;
    const marker = "<!-- phren:generated-agents -->";
    if (!fs.readFileSync(agentsPath, "utf8").includes(marker)) continue;
    atomicWriteText(agentsPath, `${fs.readFileSync(claudePath, "utf8").trimEnd()}\n\n${marker}\n${renderSkillInstructionsSection(manifest)}\n`);
  }
}
