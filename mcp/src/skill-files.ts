import * as fs from "fs";
import * as path from "path";
import { homePath } from "./shared.js";
import { findProjectDir } from "./project-locator.js";
import { buildSkillManifest, type SkillManifest } from "./skill-registry.js";
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

export function syncScopeSkillsToDir(cortexPath: string, scope: string, destDir: string): SkillManifest {
  const manifest = buildSkillManifest(cortexPath, "", scope, destDir);
  const expectedNames = new Set<string>();
  fs.mkdirSync(destDir, { recursive: true });

  for (const skill of manifest.skills) {
    const destName = skill.format === "folder" ? skill.name : path.basename(skill.path);
    const destPath = path.join(destDir, destName);
    if (!skill.visibleToAgents) {
      removeManagedSkillLink(destPath, cortexPath);
      continue;
    }
    expectedNames.add(destName);
    symlinkManagedSkill(skill.root, destPath, cortexPath);
  }

  for (const entry of fs.readdirSync(destDir)) {
    if (expectedNames.has(entry)) continue;
    removeManagedSkillLink(path.join(destDir, entry), cortexPath);
  }

  writeSkillArtifacts(destDir, manifest);
  return manifest;
}

export function syncSkillLinksForScope(cortexPath: string, scope: string): SkillManifest | null {
  if (scope.toLowerCase() === "global") {
    return syncScopeSkillsToDir(cortexPath, "global", homePath(".claude", "skills"));
  }

  const projectDir = findProjectDir(scope);
  if (!projectDir) return null;
  return syncScopeSkillsToDir(cortexPath, scope, path.join(projectDir, ".claude", "skills"));
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
