import * as fs from "fs";
import * as path from "path";
import { getProjectDirs } from "./shared.js";
import { parseSkillFrontmatter } from "./link-skills.js";
import { isSkillEnabled } from "./skill-state.js";

export interface SkillEntry {
  name: string;
  source: string;
  scopeType: "global" | "project";
  sourceKind: "canonical";
  format: "flat" | "folder";
  path: string;
  root: string;
  description?: string;
  enabled: boolean;
  command: string;
  aliases: string[];
}

export interface ResolvedSkill extends Pick<SkillEntry, "path" | "format" | "root" | "name" | "source" | "enabled" | "description" | "command" | "aliases" | "scopeType" | "sourceKind"> {
  visibleToAgents: boolean;
  commandRegistered: boolean;
  overrides: Array<{
    source: string;
    path: string;
    sourceKind: "canonical";
  }>;
  mirrorTargets: string[];
}

export interface SkillCommandRegistration {
  command: string;
  type: "skill";
  skillId: string;
  source: string;
  path: string;
  kind: "primary" | "alias";
  registered: boolean;
}

export interface SkillManifestProblem {
  code: string;
  message: string;
  command?: string;
  skillIds?: string[];
}

export interface SkillManifest {
  scope: string;
  project?: string;
  generatedAt: string;
  skills: ResolvedSkill[];
  commands: SkillCommandRegistration[];
  problems: SkillManifestProblem[];
}

function normalizeCommand(raw: unknown, fallbackName: string): string {
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : `/${fallbackName}`;
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = value.trim().startsWith("/") ? value.trim() : `/${value.trim()}`;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(normalized);
  }
  return aliases;
}

function collectSkills(
  phrenPath: string,
  root: string,
  sourceLabel: string,
  scopeType: "global" | "project",
  sourceKind: "canonical",
  seen: Set<string>,
): SkillEntry[] {
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
      scopeType,
      sourceKind,
      format: isFolder ? "folder" : "flat",
      path: filePath,
      root: isFolder ? path.dirname(filePath) : filePath,
      description: frontmatter?.description as string | undefined,
      enabled: isSkillEnabled(phrenPath, sourceLabel, name),
      command: normalizeCommand(frontmatter?.command, name),
      aliases: normalizeAliases(frontmatter?.aliases),
    });
  }

  return results;
}

function getGlobalSkills(phrenPath: string): SkillEntry[] {
  const seen = new Set<string>();
  return collectSkills(phrenPath, path.join(phrenPath, "global", "skills"), "global", "global", "canonical", seen);
}

function getProjectLocalSkills(phrenPath: string, project: string): SkillEntry[] {
  const seen = new Set<string>();
  const projectDir = path.join(phrenPath, project);
  return collectSkills(phrenPath, path.join(projectDir, "skills"), project, "project", "canonical", seen);
}

function skillPriority(skill: SkillEntry): number {
  // "user" scope (priority 500) reserved for skills the user marks as untouchable —
  // not yet wired to a scopeType value, but the priority slot is established here
  // so the ordering is stable when we add it.
  if (skill.scopeType === "project" && skill.sourceKind === "canonical") return 400;
  if (skill.scopeType === "global" && skill.sourceKind === "canonical") return 200;
  return 100;
}

function choosePreferredSkill(skills: SkillEntry[]): SkillEntry {
  return [...skills].sort((left, right) => {
    const priority = skillPriority(right) - skillPriority(left);
    if (priority !== 0) return priority;
    return left.path.localeCompare(right.path);
  })[0];
}

function buildResolvedSkills(raw: SkillEntry[], mirrorDir?: string): SkillManifest {
  const grouped = new Map<string, SkillEntry[]>();
  for (const skill of raw) {
    const key = skill.name.toLowerCase();
    const bucket = grouped.get(key) || [];
    bucket.push(skill);
    grouped.set(key, bucket);
  }

  const skills: ResolvedSkill[] = [];
  for (const [key, candidates] of grouped.entries()) {
    const chosen = choosePreferredSkill(candidates);
    const overrides = candidates
      .filter((candidate) => candidate.path !== chosen.path)
      .map((candidate) => ({
        source: candidate.source,
        path: candidate.path,
        sourceKind: candidate.sourceKind,
      }));
    const destName = chosen.format === "folder" ? chosen.name : path.basename(chosen.path);
    skills.push({
      path: chosen.path,
      format: chosen.format,
      root: chosen.root,
      name: chosen.name,
      source: chosen.source,
      enabled: chosen.enabled,
      description: chosen.description,
      command: chosen.command,
      aliases: chosen.aliases,
      scopeType: chosen.scopeType,
      sourceKind: chosen.sourceKind,
      visibleToAgents: chosen.enabled,
      commandRegistered: true,
      overrides,
      mirrorTargets: mirrorDir ? [path.join(mirrorDir, destName)] : [],
    });
    grouped.delete(key);
  }

  skills.sort((left, right) => left.name.localeCompare(right.name));

  const commandOwners = new Map<string, Array<{ skillId: string; command: string }>>();
  for (const skill of skills) {
    if (!skill.visibleToAgents) continue;
    for (const command of [skill.command, ...skill.aliases]) {
      const key = command.toLowerCase();
      const owners = commandOwners.get(key) || [];
      owners.push({ skillId: skill.name, command });
      commandOwners.set(key, owners);
    }
  }

  const problems: SkillManifestProblem[] = [];
  const collisionKeys = new Set<string>();
  for (const [key, owners] of commandOwners.entries()) {
    if (owners.length < 2) continue;
    collisionKeys.add(key);
    problems.push({
      code: "command-collision",
      command: owners[0]?.command,
      skillIds: owners.map((owner) => owner.skillId),
      message: `Command ${owners[0]?.command || key} resolves ambiguously across ${owners.map((owner) => owner.skillId).join(", ")}.`,
    });
  }

  const commands: SkillCommandRegistration[] = [];
  for (const skill of skills) {
    const commandEntries = [
      { command: skill.command, kind: "primary" as const },
      ...skill.aliases.map((alias) => ({ command: alias, kind: "alias" as const })),
    ];
    skill.commandRegistered = skill.visibleToAgents && !collisionKeys.has(skill.command.toLowerCase());
    for (const entry of commandEntries) {
      commands.push({
        command: entry.command,
        type: "skill",
        skillId: skill.name,
        source: skill.source,
        path: skill.path,
        kind: entry.kind,
        registered: skill.visibleToAgents && !collisionKeys.has(entry.command.toLowerCase()),
      });
    }
  }

  return {
    scope: "global",
    generatedAt: new Date().toISOString(),
    skills,
    commands,
    problems,
  };
}

function toResolvedSkill(skill: SkillEntry): ResolvedSkill {
  return {
    path: skill.path,
    format: skill.format,
    root: skill.root,
    name: skill.name,
    source: skill.source,
    enabled: skill.enabled,
    description: skill.description,
    command: skill.command,
    aliases: skill.aliases,
    scopeType: skill.scopeType,
    sourceKind: skill.sourceKind,
    visibleToAgents: skill.enabled,
    commandRegistered: skill.enabled,
    overrides: [],
    mirrorTargets: [],
  };
}

export function getAllSkills(phrenPath: string, profile: string): SkillEntry[] {
  const all = getGlobalSkills(phrenPath);
  for (const dir of getProjectDirs(phrenPath, profile)) {
    const source = path.basename(dir);
    if (source === "global") continue;
    all.push(...getProjectLocalSkills(phrenPath, source));
  }
  return all;
}

export function getLocalSkills(phrenPath: string, scope: string): SkillEntry[] {
  if (scope.toLowerCase() === "global") return getGlobalSkills(phrenPath);
  return getProjectLocalSkills(phrenPath, scope);
}

export function buildSkillManifest(phrenPath: string, profile: string, scope: string, mirrorDir?: string): SkillManifest {
  const manifest = scope.toLowerCase() === "global"
    ? buildResolvedSkills(getGlobalSkills(phrenPath), mirrorDir)
    : buildResolvedSkills([...getGlobalSkills(phrenPath), ...getProjectLocalSkills(phrenPath, scope)], mirrorDir);
  manifest.scope = scope;
  manifest.project = scope.toLowerCase() === "global" ? undefined : scope;
  manifest.generatedAt = new Date().toISOString();
  return manifest;
}

export function getScopedSkills(phrenPath: string, profile: string, project?: string): ResolvedSkill[] {
  if (!project) return getAllSkills(phrenPath, profile).map(toResolvedSkill);
  return buildSkillManifest(phrenPath, profile, project).skills;
}

export function findLocalSkill(phrenPath: string, scope: string, name: string): ResolvedSkill | null {
  const needle = name.replace(/\.md$/i, "").toLowerCase();
  const matches = getLocalSkills(phrenPath, scope).filter((skill) => skill.name.toLowerCase() === needle);
  if (matches.length === 0) return null;
  return toResolvedSkill(choosePreferredSkill(matches));
}

export function findSkill(phrenPath: string, profile: string, project: string | undefined, name: string): ResolvedSkill | { error: string } | null {
  const needle = name.replace(/\.md$/i, "").toLowerCase();
  if (project) {
    const matches = buildSkillManifest(phrenPath, profile, project).skills.filter((skill) => skill.name.toLowerCase() === needle);
    return matches[0] || null;
  }

  const matches = getAllSkills(phrenPath, profile).filter((skill) => skill.name.toLowerCase() === needle);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return { error: `Skill '${name}' exists in multiple scopes: ${matches.map((match) => match.source).join(", ")}. Pass project= to disambiguate.` };
  }
  return toResolvedSkill(matches[0]);
}

export function renderSkillInstructionsSection(manifest: SkillManifest): string {
  const visible = manifest.skills.filter((skill) => skill.visibleToAgents);
  const disabled = manifest.skills.filter((skill) => !skill.visibleToAgents);
  const lines = [
    "<!-- phren:generated-skills -->",
    "## Available Phren skills",
    "",
    "These skills are resolved from Phren source files and mirrored into `.claude/skills/` for agent discovery.",
    "",
  ];

  if (!visible.length) {
    lines.push("No enabled skills are resolved for this scope.");
  } else {
    lines.push("| Command | Skill | Scope | Source |");
    lines.push("| --- | --- | --- | --- |");
    for (const skill of visible) {
      lines.push(`| \`${skill.command}\` | \`${skill.name}\` | \`${skill.source}\` | \`${skill.path}\` |`);
    }
  }

  if (disabled.length) {
    lines.push("");
    lines.push("Disabled skills:");
    for (const skill of disabled) {
      lines.push(`- \`${skill.name}\` (${skill.source})`);
    }
  }

  if (manifest.problems.length) {
    lines.push("");
    lines.push("Skill registry problems:");
    for (const problem of manifest.problems) {
      lines.push(`- ${problem.message}`);
    }
  }

  lines.push("");
  lines.push("Generated artifacts:");
  lines.push("- `.claude/skill-manifest.json`");
  lines.push("- `.claude/skill-commands.json`");
  return lines.join("\n");
}
