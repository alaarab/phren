import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { getProjectDirs } from "./shared.js";
import { isValidProjectName } from "./utils.js";
import { parseSkillFrontmatter, validateSkillFrontmatter } from "./link-skills.js";

interface SkillEntry {
  name: string;
  source: string;
  format: "flat" | "folder";
  path: string;
  description?: string;
}

function collectSkills(root: string, sourceLabel: string, seen: Set<string>): SkillEntry[] {
  if (!fs.existsSync(root)) return [];
  const results: SkillEntry[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const isFolder = entry.isDirectory();
    const filePath = isFolder
      ? path.join(root, entry.name, "SKILL.md")
      : entry.name.endsWith(".md") ? path.join(root, entry.name) : null;

    if (!filePath || seen.has(filePath) || !fs.existsSync(filePath)) continue;
    seen.add(filePath);

    const { frontmatter } = parseSkillFrontmatter(fs.readFileSync(filePath, "utf8"));
    results.push({
      name: isFolder ? entry.name : entry.name.replace(/\.md$/, ""),
      source: sourceLabel,
      format: isFolder ? "folder" : "flat",
      path: filePath,
      description: frontmatter?.description as string | undefined,
    });
  }
  return results;
}

function getAllSkills(cortexPath: string, profile: string): SkillEntry[] {
  const seen = new Set<string>();
  const all = collectSkills(path.join(cortexPath, "global", "skills"), "global", seen);

  for (const dir of getProjectDirs(cortexPath, profile)) {
    const name = path.basename(dir);
    if (name === "global") continue;
    all.push(...collectSkills(path.join(dir, "skills"), name, seen));
    all.push(...collectSkills(path.join(dir, ".claude", "skills"), name, seen));
  }
  return all;
}

type FindSkillResult = { path: string } | { error: string } | null;

function findSkill(cortexPath: string, profile: string, project: string | undefined, name: string): FindSkillResult {
  const needle = name.replace(/\.md$/i, "").toLowerCase();
  const matches = getAllSkills(cortexPath, profile).filter(s =>
    s.name.toLowerCase() === needle && (!project || s.source.toLowerCase() === project.toLowerCase())
  );
  if (matches.length === 0) return null;
  if (matches.length > 1 && !project) {
    return { error: `Skill '${name}' exists in multiple scopes: ${matches.map(m => m.source).join(', ')}. Pass project= to disambiguate.` };
  }
  return { path: matches[0].path };
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, profile, withWriteQueue, updateFileInIndex } = ctx;

  // ── list_skills ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_skills",
    {
      title: "◆ cortex · skills",
      description: "List all installed skills across global and project scopes.",
      inputSchema: z.object({
        project: z.string().optional().describe("Filter to a specific project. Omit for all."),
      }),
    },
    async ({ project }) => {
      if (project && !isValidProjectName(project)) {
        return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      }

      const skills = getAllSkills(cortexPath, profile)
        .filter(s => !project || s.source.toLowerCase() === project.toLowerCase());

      if (!skills.length) {
        return mcpResponse({ ok: true, message: project ? `No skills found for "${project}".` : "No skills found.", data: { skills: [] } });
      }

      const lines = skills.map(s => `${s.name} (${s.source})${s.description ? ` — ${s.description}` : ""}`);
      return mcpResponse({
        ok: true,
        message: `${skills.length} skill(s):\n${lines.join("\n")}`,
        data: { skills: skills.map(({ name, source, format, path: p, description }) => ({ name, source, format, path: p, description: description ?? null })) },
      });
    }
  );

  // ── read_skill ───────────────────────────────────────────────────────────

  server.registerTool(
    "read_skill",
    {
      title: "◆ cortex · read skill",
      description: "Read a skill file's full contents with parsed frontmatter and validation.",
      inputSchema: z.object({
        name: z.string().describe("Skill name (without .md)."),
        project: z.string().optional().describe("Project scope. Omit to search all."),
      }),
    },
    async ({ name, project }) => {
      if (project && !isValidProjectName(project)) {
        return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      }

      const result = findSkill(cortexPath, profile, project, name);
      if (!result) {
        return mcpResponse({ ok: false, error: `Skill "${name}" not found${project ? ` in "${project}"` : ""}.` });
      }
      if ("error" in result) {
        return mcpResponse({ ok: false, error: result.error });
      }

      const content = fs.readFileSync(result.path, "utf8");
      const { frontmatter, body } = parseSkillFrontmatter(content);
      const { valid, errors } = validateSkillFrontmatter(content, result.path);

      return mcpResponse({
        ok: true,
        message: content,
        data: { path: result.path, content, frontmatter: frontmatter ?? null, body, valid, errors },
      });
    }
  );

  // ── write_skill ──────────────────────────────────────────────────────────

  server.registerTool(
    "write_skill",
    {
      title: "◆ cortex · write skill",
      description: "Create or update a skill file with frontmatter validation. Scope: 'global' or a project name.",
      inputSchema: z.object({
        name: z.string().describe("Skill name (without .md)."),
        content: z.string().describe("Full skill content including YAML frontmatter."),
        scope: z.string().describe("'global' or a project name."),
      }),
    },
    async ({ name, content, scope }) => {
      if (scope.toLowerCase() !== "global" && !isValidProjectName(scope)) {
        return mcpResponse({ ok: false, error: `Invalid scope: "${scope}". Use 'global' or a project name.` });
      }

      // Validate name is a safe basename: no path separators, no .. segments
      const safeName = name.replace(/\.md$/i, "");
      if (!safeName || safeName.includes("/") || safeName.includes("\\") || safeName.includes("..") || path.basename(safeName) !== safeName) {
        return mcpResponse({ ok: false, error: `Invalid skill name: "${name}". Must be a simple filename with no path separators or traversal sequences.` });
      }

      const { valid, errors } = validateSkillFrontmatter(content);
      if (!valid) {
        return mcpResponse({ ok: false, error: `Invalid frontmatter: ${errors.join("; ")}` });
      }

      return withWriteQueue(async () => {
        const destDir = scope.toLowerCase() === "global"
          ? path.join(cortexPath, "global", "skills")
          : path.join(cortexPath, scope, ".claude", "skills");

        if (scope.toLowerCase() !== "global" && !fs.existsSync(path.join(cortexPath, scope))) {
          return mcpResponse({ ok: false, error: `Project "${scope}" not found.` });
        }

        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, `${name.replace(/\.md$/i, "")}.md`);
        const existed = fs.existsSync(dest);

        fs.writeFileSync(dest, content);
        updateFileInIndex(dest);

        return mcpResponse({ ok: true, message: `${existed ? "Updated" : "Created"} skill "${name}" in ${scope}.`, data: { path: dest, created: !existed } });
      });
    }
  );

  // ── remove_skill ─────────────────────────────────────────────────────────

  server.registerTool(
    "remove_skill",
    {
      title: "◆ cortex · remove skill",
      description: "Remove a skill file by name.",
      inputSchema: z.object({
        name: z.string().describe("Skill name (without .md)."),
        project: z.string().optional().describe("Project scope. Omit to search all."),
      }),
    },
    async ({ name, project }) => {
      if (project && !isValidProjectName(project)) {
        return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      }

      const result = findSkill(cortexPath, profile, project, name);
      if (!result) {
        return mcpResponse({ ok: false, error: `Skill "${name}" not found${project ? ` in "${project}"` : ""}.` });
      }
      if ("error" in result) {
        return mcpResponse({ ok: false, error: result.error });
      }

      return withWriteQueue(async () => {
        fs.unlinkSync(result.path);
        updateFileInIndex(result.path); // called after delete so indexer removes the entry
        return mcpResponse({ ok: true, message: `Removed skill "${name}" (${result.path}).`, data: { path: result.path } });
      });
    }
  );
}
