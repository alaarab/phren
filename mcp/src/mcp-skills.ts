import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { isValidProjectName } from "./utils.js";
import { parseSkillFrontmatter, validateSkillFrontmatter } from "./link-skills.js";
import { removeSkillPath, setSkillEnabledAndSync } from "./skill-files.js";
import { buildSkillManifest, findLocalSkill, findSkill, getAllSkills } from "./skill-registry.js";

export function register(server: McpServer, ctx: McpContext): void {
  const { phrenPath, profile, withWriteQueue, updateFileInIndex } = ctx;

  // ── list_skills ──────────────────────────────────────────────────────────

  server.registerTool(
    "list_skills",
    {
      title: "◆ phren · skills",
      description: "List all installed skills across global and project scopes.",
      inputSchema: z.object({
        project: z.string().optional().describe("Filter to a specific project. Omit for all."),
      }),
    },
    async ({ project }) => {
      if (project && !isValidProjectName(project)) {
        return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      }

      const resolvedSkills = project ? buildSkillManifest(phrenPath, profile, project).skills : null;
      const rawSkills = project ? null : getAllSkills(phrenPath, profile);
      const skills = resolvedSkills || rawSkills || [];

      if (!skills.length) {
        return mcpResponse({ ok: true, message: project ? `No skills found for "${project}".` : "No skills found.", data: { skills: [] } });
      }

      const lines = skills.map(s => `${s.command} -> ${s.name} (${s.source}; ${s.enabled ? "enabled" : "disabled"})${s.description ? ` — ${s.description}` : ""}`);
      const serialized = resolvedSkills
        ? resolvedSkills.map(({ name, source, format, path: p, description, enabled, command, aliases, visibleToAgents, commandRegistered, overrides, mirrorTargets }) => ({
          name,
          source,
          format,
          path: p,
          description: description ?? null,
          enabled,
          command: command ?? null,
          aliases,
          visibleToAgents,
          commandRegistered,
          overrides,
          mirrorTargets,
        }))
        : (rawSkills || []).map(({ name, source, format, path: p, description, enabled, command, aliases }) => ({
          name,
          source,
          format,
          path: p,
          description: description ?? null,
          enabled,
          command: command ?? null,
          aliases,
          visibleToAgents: enabled,
          commandRegistered: enabled,
          overrides: [],
          mirrorTargets: [],
        }));
      return mcpResponse({
        ok: true,
        message: `${skills.length} skill(s):\n${lines.join("\n")}`,
        data: { skills: serialized },
      });
    }
  );

  // ── read_skill ───────────────────────────────────────────────────────────

  server.registerTool(
    "read_skill",
    {
      title: "◆ phren · read skill",
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

      const result = findSkill(phrenPath, profile, project, name);
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
      title: "◆ phren · write skill",
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
          ? path.join(phrenPath, "global", "skills")
          : path.join(phrenPath, scope, "skills");

        if (scope.toLowerCase() !== "global" && !fs.existsSync(path.join(phrenPath, scope))) {
          return mcpResponse({ ok: false, error: `Project "${scope}" not found.` });
        }

        fs.mkdirSync(destDir, { recursive: true });
        const existing = findLocalSkill(phrenPath, scope, safeName);
        const dest = existing
          ? existing.path
          : path.join(destDir, `${safeName}.md`);
        const existed = Boolean(existing) || fs.existsSync(dest);

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
      title: "◆ phren · remove skill",
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

      const result = project ? findLocalSkill(phrenPath, project, name) : findSkill(phrenPath, profile, project, name);
      if (!result) {
        return mcpResponse({ ok: false, error: `Skill "${name}" not found${project ? ` in "${project}"` : ""}.` });
      }
      if ("error" in result) {
        return mcpResponse({ ok: false, error: result.error });
      }

      return withWriteQueue(async () => {
        const removedPath = removeSkillPath(result.format === "folder" ? result.root : result.path);
        updateFileInIndex(result.path); // called after delete so indexer removes the entry
        return mcpResponse({ ok: true, message: `Removed skill "${name}" (${removedPath}).`, data: { path: removedPath } });
      });
    }
  );

  for (const action of [
    { tool: "enable_skill", enabled: true, verb: "Enable" },
    { tool: "disable_skill", enabled: false, verb: "Disable" },
  ] as const) {
    server.registerTool(
      action.tool,
      {
        title: `◆ phren · ${action.enabled ? "enable" : "disable"} skill`,
        description: `${action.verb} a skill without deleting its file.`,
        inputSchema: z.object({
          name: z.string().describe("Skill name (without .md)."),
          project: z.string().describe("Project scope or 'global'."),
        }),
      },
      async ({ name, project }) => {
        if (project.toLowerCase() !== "global" && !isValidProjectName(project)) {
          return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
        }

        const result = findSkill(phrenPath, profile, project, name);
        if (!result) {
          return mcpResponse({ ok: false, error: `Skill "${name}" not found in "${project}".` });
        }
        if ("error" in result) {
          return mcpResponse({ ok: false, error: result.error });
        }

        return withWriteQueue(async () => {
          setSkillEnabledAndSync(phrenPath, project, result.name, action.enabled);
          return mcpResponse({
            ok: true,
            message: `${action.verb}d skill "${result.name}" in ${project}.`,
            data: { name: result.name, project, enabled: action.enabled },
          });
        });
      }
    );
  }
}
