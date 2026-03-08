import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { debugLog } from "./shared.js";
import { buildLifecycleCommands } from "./hooks.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Skill frontmatter parsing and validation ────────────────────────────────

export interface ManifestHooks {
  SessionStart?: string;
  UserPromptSubmit?: string;
  Stop?: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  license?: string;
  dependencies?: string[];
  hooks?: Record<string, unknown>;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  frontmatter?: SkillFrontmatter;
}

const REQUIRED_SKILL_FIELDS = ["name", "description"] as const;

export function parseSkillFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };
  try {
    const parsed = yaml.load(match[1]) as Record<string, unknown>;
    return { frontmatter: parsed && typeof parsed === "object" ? parsed : null, body: match[2] };
  } catch (err: unknown) {
    debugLog(`parseSkillFrontmatter: malformed YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`);
    return { frontmatter: null, body: content };
  }
}

export function validateSkillFrontmatter(content: string, filePath?: string): SkillValidationResult {
  const { frontmatter } = parseSkillFrontmatter(content);
  const prefix = filePath ? `${filePath}: ` : "";
  if (!frontmatter) return { valid: false, errors: [`${prefix}missing or invalid YAML frontmatter`] };

  const errors: string[] = [];
  for (const field of REQUIRED_SKILL_FIELDS) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field]) {
      errors.push(`${prefix}missing required field "${field}"`);
    }
  }

  if (frontmatter.dependencies !== undefined) {
    if (!Array.isArray(frontmatter.dependencies)) {
      errors.push(`${prefix}"dependencies" must be an array`);
    } else if (frontmatter.dependencies.some((d: unknown) => typeof d !== "string")) {
      errors.push(`${prefix}"dependencies" entries must be strings`);
    }
  }

  if (frontmatter.hooks !== undefined && (typeof frontmatter.hooks !== "object" || frontmatter.hooks === null)) {
    errors.push(`${prefix}"hooks" must be an object`);
  }

  if (frontmatter.version !== undefined && typeof frontmatter.version !== "string") {
    errors.push(`${prefix}"version" must be a string`);
  }

  return {
    valid: errors.length === 0,
    errors,
    frontmatter: errors.length === 0 ? frontmatter as unknown as SkillFrontmatter : undefined,
  };
}

export function validateSkillsDir(skillsDir: string): SkillValidationResult[] {
  if (!fs.existsSync(skillsDir)) return [];
  const results: SkillValidationResult[] = [];
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      const skillFile = path.join(entryPath, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        results.push(validateSkillFrontmatter(fs.readFileSync(skillFile, "utf8"), skillFile));
      }
    } else if (stat.isFile() && entry.endsWith(".md")) {
      results.push(validateSkillFrontmatter(fs.readFileSync(entryPath, "utf8"), entryPath));
    }
  }
  return results;
}

export function migrateSkillsToFolders(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) return [];
  const migrated: string[] = [];
  for (const entry of fs.readdirSync(skillsDir)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(skillsDir, entry);
    if (!fs.statSync(filePath).isFile()) continue;
    const name = entry.replace(/\.md$/, "");
    const folderPath = path.join(skillsDir, name);
    if (fs.existsSync(folderPath)) continue;
    fs.mkdirSync(folderPath, { recursive: true });
    fs.renameSync(filePath, path.join(folderPath, "SKILL.md"));
    migrated.push(name);
  }
  return migrated;
}

export function readSkillManifestHooks(cortexPath: string): ManifestHooks | null {
  const manifestPath = path.join(cortexPath, "cortex.SKILL.md");
  if (!fs.existsSync(manifestPath)) return null;

  const content = fs.readFileSync(manifestPath, "utf8");
  const { frontmatter } = parseSkillFrontmatter(content);
  if (!frontmatter || typeof frontmatter.hooks !== "object" || !frontmatter.hooks) return null;

  const hooks = frontmatter.hooks as Record<string, unknown>;
  const result: ManifestHooks = {};

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value) || !value[0]) continue;
    const entry = value[0] as Record<string, unknown>;
    const hooksList = entry.hooks as unknown[];
    if (!Array.isArray(hooksList) || !hooksList[0]) continue;
    const hookDef = hooksList[0] as Record<string, unknown>;
    if (typeof hookDef.command === "string") {
      (result as Record<string, string>)[event] = hookDef.command;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── Skill linking helpers ───────────────────────────────────────────────────

export function linkSkillsDir(srcDir: string, destDir: string, managedRoot: string, symlinkFile: (src: string, dest: string, managedRoot: string) => boolean) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  for (const entry of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, entry);
    const stat = fs.statSync(srcPath);

    if (stat.isFile() && entry.endsWith(".md")) {
      symlinkFile(srcPath, path.join(destDir, entry), managedRoot);
    } else if (stat.isDirectory()) {
      const skillFile = path.join(srcPath, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        symlinkFile(skillFile, path.join(destDir, `${entry}.md`), managedRoot);
      }
    }
  }
}

function getPackageVersion(): string {
  try {
    const pkgPath = path.join(ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "1.0.0";
  } catch (err: unknown) {
    debugLog(`getPackageVersion: failed to read package.json: ${err instanceof Error ? err.message : String(err)}`);
    return "1.0.0";
  }
}

export function writeSkillMd(cortexPath: string) {
  const lifecycle = buildLifecycleCommands(cortexPath);
  const sessionStartCmd = lifecycle.sessionStart.replace(/"/g, '\\"');
  const promptCmd = lifecycle.userPromptSubmit.replace(/"/g, '\\"');
  const stopCmd = lifecycle.stop.replace(/"/g, '\\"');
  const version = getPackageVersion();

  const content = `---
name: cortex
description: Long-term memory for your AI agents with automatic context injection and finding capture
version: "${version}"
license: MIT
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${sessionStartCmd}"
  UserPromptSubmit:
    - hooks:
        - type: command
          command: "${promptCmd}"
          timeout: 3
  Stop:
    - hooks:
        - type: command
          command: "${stopCmd}"
---

# cortex

Long-term memory for your AI agents. Injects relevant project context at the start of
each prompt and saves findings at session end via git. Works with Claude Code, Copilot CLI,
Cursor, Codex, and more.

## Lifecycle hooks

- **SessionStart**: pulls latest cortex data and self-heals hook/symlink drift
- **UserPromptSubmit**: searches cortex, injects matching context with trust filtering and token budgeting
- **Stop**: commits and pushes any cortex changes to remote

## MCP tools (29)

**Search and browse:**
- \`search_knowledge\`: FTS5 search with synonym expansion across the project store
- \`get_memory_detail\`: fetch full content of a memory by id (progressive disclosure)
- \`get_project_summary\`: project summary card and available docs
- \`list_projects\`: all projects in the active profile
- \`get_findings\`: read recent findings without a search query

**Backlog management:**
- \`get_backlog\`: read tasks for one or all projects, or fetch a single item by ID or text
- \`add_backlog_item\`: add a task to the Queue section
- \`add_backlog_items\`: bulk add multiple tasks in one call
- \`complete_backlog_item\`: match by text, move to Done
- \`complete_backlog_items\`: bulk complete multiple items in one call
- \`update_backlog_item\`: change priority, context, or section

**Finding capture:**
- \`add_finding\`: append insight under today\'s date with optional citation metadata
- \`add_findings\`: bulk add multiple findings in one call
- \`remove_finding\`: remove a finding by matching text
- \`remove_findings\`: bulk remove multiple findings in one call
- \`push_changes\`: commit and push all cortex changes

**Memory quality:**
- \`pin_memory\`: promote important memory into CANONICAL_MEMORIES.md
- \`memory_feedback\`: record helpful/reprompt/regression outcomes

**Data management:**
- \`export_project\`: export project data as portable JSON for sharing or backup
- \`import_project\`: import project from previously exported JSON
- \`manage_project(project, action: "archive"|"unarchive")\`: archive or restore a project

`;

  const dest = path.join(cortexPath, "cortex.SKILL.md");
  fs.writeFileSync(dest, content);
}
