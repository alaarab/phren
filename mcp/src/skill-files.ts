import * as fs from "fs";
import * as path from "path";
import { homePath } from "./shared.js";
import { findProjectDir } from "./link.js";
import { getAllSkills } from "./skill-registry.js";
import { setSkillEnabled } from "./skill-state.js";
import { errorMessage } from "./utils.js";

function normalizeSkillRemovalTarget(skillPath: string): string {
  if (!skillPath) return skillPath;
  if (path.basename(skillPath).toLowerCase() === "skill.md") {
    return path.dirname(skillPath);
  }
  return skillPath;
}

function symlinkManagedSkill(src: string, dest: string, managedRoot: string): void {
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(dest);
      const resolvedTarget = path.resolve(path.dirname(dest), currentTarget);
      const managedPrefix = path.resolve(managedRoot) + path.sep;
      if (resolvedTarget === path.resolve(src)) return;
      if (!resolvedTarget.startsWith(managedPrefix)) return;
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

function removeManagedSkillLink(dest: string, managedRoot: string): void {
  try {
    const stat = fs.lstatSync(dest);
    if (!stat.isSymbolicLink()) return;
    const currentTarget = fs.readlinkSync(dest);
    const resolvedTarget = path.resolve(path.dirname(dest), currentTarget);
    const managedPrefix = path.resolve(managedRoot) + path.sep;
    if (!resolvedTarget.startsWith(managedPrefix)) return;
    fs.unlinkSync(dest);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && process.env.CORTEX_DEBUG) {
      process.stderr.write(`[cortex] removeManagedSkillLink: ${errorMessage(err)}\n`);
    }
  }
}

function syncScopeSkills(cortexPath: string, scope: string, destDir: string): void {
  const managed = getAllSkills(cortexPath, "").filter((skill) => skill.source.toLowerCase() === scope.toLowerCase());
  const expectedNames = new Set<string>();

  for (const skill of managed) {
    const destName = skill.format === "folder" ? skill.name : path.basename(skill.path);
    const destPath = path.join(destDir, destName);
    if (!skill.enabled) {
      removeManagedSkillLink(destPath, cortexPath);
      continue;
    }
    expectedNames.add(destName);
    symlinkManagedSkill(skill.root, destPath, cortexPath);
  }

  if (!fs.existsSync(destDir)) return;
  for (const entry of fs.readdirSync(destDir)) {
    if (expectedNames.has(entry)) continue;
    removeManagedSkillLink(path.join(destDir, entry), cortexPath);
  }
}

export function syncSkillLinksForScope(cortexPath: string, scope: string): void {
  if (scope.toLowerCase() === "global") {
    syncScopeSkills(cortexPath, "global", homePath(".claude", "skills"));
    return;
  }

  const projectDir = findProjectDir(scope);
  if (!projectDir) return;
  syncScopeSkills(cortexPath, scope, path.join(projectDir, ".claude", "skills"));
}

export function setSkillEnabledAndSync(cortexPath: string, scope: string, name: string, enabled: boolean): void {
  setSkillEnabled(cortexPath, scope, name, enabled);
  syncSkillLinksForScope(cortexPath, scope);
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
