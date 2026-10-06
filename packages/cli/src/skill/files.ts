import * as fs from "fs";
import * as path from "path";
import { homePath } from "../shared.js";
import { findProjectDir } from "../project-locator.js";
import { buildSkillManifest, type SkillManifest } from "./registry.js";
import { setSkillEnabled } from "./state.js";
import { errorMessage } from "../utils.js";
import { isManagedSymlink } from "../link/skills.js";
import { logger } from "../logger.js";
import { getNonPrimaryStores } from "../store-registry.js";

function normalizeSkillRemovalTarget(skillPath: string): string {
  if (!skillPath) return skillPath;
  if (path.basename(skillPath).toLowerCase() === "skill.md") {
    return path.dirname(skillPath);
  }
  return skillPath;
}

/** Every store root whose skills phren links, so a link into a team store counts as phren's own. */
function managedSkillRoots(phrenPath: string): string[] {
  return [phrenPath, ...getNonPrimaryStores(phrenPath).map((store) => store.path)];
}

function isManagedSkillLink(dest: string, managedRoots: string[]): boolean {
  return managedRoots.some((root) => isManagedSymlink(dest, root));
}

function symlinkManagedSkill(src: string, dest: string, managedRoots: string[]): void {
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(dest);
      const resolvedTarget = path.resolve(path.dirname(dest), currentTarget);
      if (resolvedTarget === path.resolve(src)) return;
      if (!isManagedSkillLink(dest, managedRoots)) return;
      fs.unlinkSync(dest);
    } else {
      return;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(src, dest);
}

function removeManagedSkillLink(dest: string, managedRoots: string[]): void {
  try {
    if (!isManagedSkillLink(dest, managedRoots)) return;
    fs.unlinkSync(dest);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") logger.debug("skill-files", `removeManagedSkillLink: ${errorMessage(err)}`);
  }
}

function writeSkillArtifacts(destDir: string, manifest: SkillManifest): void {
  const parentDir = path.dirname(destDir);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(path.join(parentDir, "skill-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(parentDir, "skill-commands.json"),
    `${JSON.stringify({
      scope: manifest.scope,
      project: manifest.project,
      generatedAt: manifest.generatedAt,
      commands: manifest.commands.filter((command) => command.registered),
      problems: manifest.problems,
    }, null, 2)}\n`,
  );
}

export function syncScopeSkillsToDir(phrenPath: string, scope: string, destDir: string): SkillManifest {
  const manifest = buildSkillManifest(phrenPath, "", scope, destDir);
  const expectedNames = new Set<string>();
  const managedRoots = managedSkillRoots(phrenPath);
  fs.mkdirSync(destDir, { recursive: true });

  for (const skill of manifest.skills) {
    const destName = skill.format === "folder" ? skill.name : path.basename(skill.path);
    const destPath = path.join(destDir, destName);
    if (!skill.visibleToAgents) {
      removeManagedSkillLink(destPath, managedRoots);
      continue;
    }
    expectedNames.add(destName);
    symlinkManagedSkill(skill.root, destPath, managedRoots);
  }

  for (const entry of fs.readdirSync(destDir)) {
    if (expectedNames.has(entry)) continue;
    removeManagedSkillLink(path.join(destDir, entry), managedRoots);
  }

  writeSkillArtifacts(destDir, manifest);
  return manifest;
}

export function syncSkillLinksForScope(phrenPath: string, scope: string): SkillManifest | null {
  if (scope.toLowerCase() === "global") {
    const manifest = syncScopeSkillsToDir(phrenPath, "global", homePath(".claude", "skills"));
    for (const tool of [".agents", ".copilot"]) {
      const dir = homePath(tool, "skills");
      if (fs.existsSync(path.join(path.dirname(dir), "skill-manifest.json"))) syncScopeSkillsToDir(phrenPath, "global", dir);
    }
    return manifest;
  }

  const projectDir = findProjectDir(scope);
  if (!projectDir) return null;
  return syncScopeSkillsToDir(phrenPath, scope, path.join(projectDir, ".claude", "skills"));
}

export function setSkillEnabledAndSync(phrenPath: string, scope: string, name: string, enabled: boolean): void {
  setSkillEnabled(phrenPath, scope, name, enabled);
  syncSkillLinksForScope(phrenPath, scope);
}

export function removeSkillPath(skillPath: string): string {
  const target = normalizeSkillRemovalTarget(skillPath);
  if (!target || !fs.existsSync(target)) return target;

  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.unlinkSync(target);
  }
  return target;
}
