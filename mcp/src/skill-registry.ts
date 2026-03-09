import * as fs from "fs";
import * as path from "path";
import { getProjectDirs } from "./shared.js";
import { parseSkillFrontmatter } from "./link-skills.js";
import { isSkillEnabled } from "./skill-state.js";

export interface SkillEntry {
  name: string;
  source: string;
  format: "flat" | "folder";
  path: string;
  root: string;
  description?: string;
  enabled: boolean;
}

function collectSkills(cortexPath: string, root: string, sourceLabel: string, seen: Set<string>): SkillEntry[] {
  if (!fs.existsSync(root)) return [];
  const results: SkillEntry[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const isFolder = entry.isDirectory();
    const filePath = isFolder
      ? path.join(root, entry.name, "SKILL.md")
      : entry.name.endsWith(".md") ? path.join(root, entry.name) : null;

    if (!filePath || seen.has(filePath) || !fs.existsSync(filePath)) continue;
    seen.add(filePath);

    const name = isFolder ? entry.name : entry.name.replace(/\.md$/, "");
    const { frontmatter } = parseSkillFrontmatter(fs.readFileSync(filePath, "utf8"));
    results.push({
      name,
      source: sourceLabel,
      format: isFolder ? "folder" : "flat",
      path: filePath,
      root: isFolder ? path.dirname(filePath) : filePath,
      description: frontmatter?.description as string | undefined,
      enabled: isSkillEnabled(cortexPath, sourceLabel, name),
    });
  }

  return results;
}

export function getAllSkills(cortexPath: string, profile: string): SkillEntry[] {
  const seen = new Set<string>();
  const all = collectSkills(cortexPath, path.join(cortexPath, "global", "skills"), "global", seen);

  for (const dir of getProjectDirs(cortexPath, profile)) {
    const source = path.basename(dir);
    if (source === "global") continue;
    all.push(...collectSkills(cortexPath, path.join(dir, "skills"), source, seen));
    all.push(...collectSkills(cortexPath, path.join(dir, ".claude", "skills"), source, seen));
  }

  return all;
}

export function getScopedSkills(cortexPath: string, profile: string, project?: string): SkillEntry[] {
  if (!project) return getAllSkills(cortexPath, profile);
  const seen = new Set<string>();
  if (project.toLowerCase() === "global") {
    return collectSkills(cortexPath, path.join(cortexPath, "global", "skills"), "global", seen);
  }
  const projectDir = path.join(cortexPath, project);
  return [
    ...collectSkills(cortexPath, path.join(projectDir, "skills"), project, seen),
    ...collectSkills(cortexPath, path.join(projectDir, ".claude", "skills"), project, seen),
  ];
}

export type ResolvedSkill = Pick<SkillEntry, "path" | "format" | "root" | "name" | "source" | "enabled">;

export function findSkill(cortexPath: string, profile: string, project: string | undefined, name: string): ResolvedSkill | { error: string } | null {
  const needle = name.replace(/\.md$/i, "").toLowerCase();
  const matches = getScopedSkills(cortexPath, profile, project).filter((skill) =>
    skill.name.toLowerCase() === needle && (!project || skill.source.toLowerCase() === project.toLowerCase())
  );
  if (matches.length === 0) return null;
  if (matches.length > 1 && !project) {
    return { error: `Skill '${name}' exists in multiple scopes: ${matches.map((match) => match.source).join(", ")}. Pass project= to disambiguate.` };
  }
  const skill = matches[0];
  return {
    path: skill.path,
    format: skill.format,
    root: skill.root,
    name: skill.name,
    source: skill.source,
    enabled: skill.enabled,
  };
}
