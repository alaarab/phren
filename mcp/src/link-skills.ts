import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";
import { buildSharedLifecycleCommands } from "./hooks.js";
import { VERSION } from "./package-metadata.js";
import { getToolCount, renderToolCatalogMarkdown } from "./tool-registry.js";
import { isSkillEnabled } from "./skill-state.js";

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
  command?: string;
  aliases?: string[];
}

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  frontmatter?: SkillFrontmatter;
}

const REQUIRED_SKILL_FIELDS = ["name", "description"] as const;

export function parseSkillFrontmatter(rawContent: string): { frontmatter: Record<string, unknown> | null; body: string } {
  // Normalize UTF-8 BOM and Windows-style CRLF line endings before matching frontmatter
  const content = rawContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };
  try {
    const parsed = yaml.load(match[1]) as Record<string, unknown>;
    return { frontmatter: parsed && typeof parsed === "object" ? parsed : null, body: match[2] };
  } catch (err: unknown) {
    debugLog(`parseSkillFrontmatter: malformed YAML frontmatter: ${errorMessage(err)}`);
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

  if (frontmatter.command !== undefined && typeof frontmatter.command !== "string") {
    errors.push(`${prefix}"command" must be a string`);
  }

  if (frontmatter.aliases !== undefined) {
    if (!Array.isArray(frontmatter.aliases)) {
      errors.push(`${prefix}"aliases" must be an array`);
    } else if (frontmatter.aliases.some((alias: unknown) => typeof alias !== "string")) {
      errors.push(`${prefix}"aliases" entries must be strings`);
    }
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

function cleanupManagedSkillLinks(destDir: string, expectedNames: Set<string>, managedRoot: string): void {
  if (!fs.existsSync(destDir)) return;
  for (const entry of fs.readdirSync(destDir)) {
    if (expectedNames.has(entry)) continue;
    const destPath = path.join(destDir, entry);
    try {
      const stat = fs.lstatSync(destPath);
      if (!stat.isSymbolicLink()) continue;
      const target = fs.readlinkSync(destPath);
      const resolvedTarget = path.resolve(path.dirname(destPath), target);
      const managedPrefix = path.resolve(managedRoot) + path.sep;
      if (!resolvedTarget.startsWith(managedPrefix)) continue;
      fs.unlinkSync(destPath);
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cleanupManagedSkillLinks: ${errorMessage(err)}\n`);
    }
  }
}

export function linkSkillsDir(
  srcDir: string,
  destDir: string,
  managedRoot: string,
  symlinkFile: (src: string, dest: string, managedRoot: string) => boolean,
  opts?: { cortexPath?: string; scope?: string },
) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  const expectedNames = new Set<string>();

  for (const entry of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, entry);
    const stat = fs.statSync(srcPath);
    const skillName = stat.isDirectory() ? entry : entry.replace(/\.md$/, "");
    if (opts?.cortexPath && opts.scope && !isSkillEnabled(opts.cortexPath, opts.scope, skillName)) {
      continue;
    }

    if (stat.isFile() && entry.endsWith(".md")) {
      expectedNames.add(entry);
      symlinkFile(srcPath, path.join(destDir, entry), managedRoot);
    } else if (stat.isDirectory()) {
      const skillFile = path.join(srcPath, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        expectedNames.add(entry);
        // Symlink the entire skill directory so bundled scripts and assets are accessible.
        // Relative paths in the skill body remain valid because the directory structure is preserved.
        symlinkFile(srcPath, path.join(destDir, entry), managedRoot);
      }
    }
  }

  cleanupManagedSkillLinks(destDir, expectedNames, managedRoot);
}

export function writeSkillMd(cortexPath: string) {
  const lifecycle = buildSharedLifecycleCommands();
  const sessionStartCmd = lifecycle.sessionStart.replace(/"/g, '\\"');
  const promptCmd = lifecycle.userPromptSubmit.replace(/"/g, '\\"');
  const stopCmd = lifecycle.stop.replace(/"/g, '\\"');
  const version = VERSION;
  const toolCount = getToolCount();
  const toolCatalog = renderToolCatalogMarkdown();

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

## MCP tools (${toolCount})

${toolCatalog}

`;

  const dest = path.join(cortexPath, "cortex.SKILL.md");
  fs.writeFileSync(dest, content);
}
