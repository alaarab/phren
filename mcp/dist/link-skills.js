import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";
import { buildSharedLifecycleCommands } from "./hooks.js";
import { VERSION } from "./package-metadata.js";
import { getToolCount, renderToolCatalogMarkdown } from "./tool-registry.js";
import { isSkillEnabled } from "./skill-state.js";
const REQUIRED_SKILL_FIELDS = ["name", "description"];
export function parseSkillFrontmatter(rawContent) {
    // Normalize UTF-8 BOM and Windows-style CRLF line endings before matching frontmatter
    const content = rawContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match)
        return { frontmatter: null, body: content };
    try {
        const parsed = yaml.load(match[1]);
        return { frontmatter: parsed && typeof parsed === "object" ? parsed : null, body: match[2] };
    }
    catch (err) {
        debugLog(`parseSkillFrontmatter: malformed YAML frontmatter: ${errorMessage(err)}`);
        return { frontmatter: null, body: content };
    }
}
export function validateSkillFrontmatter(content, filePath) {
    const { frontmatter } = parseSkillFrontmatter(content);
    const prefix = filePath ? `${filePath}: ` : "";
    if (!frontmatter)
        return { valid: false, errors: [`${prefix}missing or invalid YAML frontmatter`] };
    const errors = [];
    for (const field of REQUIRED_SKILL_FIELDS) {
        if (typeof frontmatter[field] !== "string" || !frontmatter[field]) {
            errors.push(`${prefix}missing required field "${field}"`);
        }
    }
    if (frontmatter.dependencies !== undefined) {
        if (!Array.isArray(frontmatter.dependencies)) {
            errors.push(`${prefix}"dependencies" must be an array`);
        }
        else if (frontmatter.dependencies.some((d) => typeof d !== "string")) {
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
        }
        else if (frontmatter.aliases.some((alias) => typeof alias !== "string")) {
            errors.push(`${prefix}"aliases" entries must be strings`);
        }
    }
    return {
        valid: errors.length === 0,
        errors,
        frontmatter: errors.length === 0 ? frontmatter : undefined,
    };
}
export function validateSkillsDir(skillsDir) {
    if (!fs.existsSync(skillsDir))
        return [];
    const results = [];
    for (const entry of fs.readdirSync(skillsDir)) {
        const entryPath = path.join(skillsDir, entry);
        const stat = fs.statSync(entryPath);
        if (stat.isDirectory()) {
            const skillFile = path.join(entryPath, "SKILL.md");
            if (fs.existsSync(skillFile)) {
                results.push(validateSkillFrontmatter(fs.readFileSync(skillFile, "utf8"), skillFile));
            }
        }
        else if (stat.isFile() && entry.endsWith(".md")) {
            results.push(validateSkillFrontmatter(fs.readFileSync(entryPath, "utf8"), entryPath));
        }
    }
    return results;
}
export function readSkillManifestHooks(phrenPath) {
    const manifestPath = path.join(phrenPath, "phren.SKILL.md");
    if (!fs.existsSync(manifestPath))
        return null;
    const content = fs.readFileSync(manifestPath, "utf8");
    const { frontmatter } = parseSkillFrontmatter(content);
    if (!frontmatter || typeof frontmatter.hooks !== "object" || !frontmatter.hooks)
        return null;
    const hooks = frontmatter.hooks;
    const result = {};
    for (const [event, value] of Object.entries(hooks)) {
        if (!Array.isArray(value) || !value[0])
            continue;
        const entry = value[0];
        const hooksList = entry.hooks;
        if (!Array.isArray(hooksList) || !hooksList[0])
            continue;
        const hookDef = hooksList[0];
        if (typeof hookDef.command === "string") {
            result[event] = hookDef.command;
        }
    }
    return Object.keys(result).length > 0 ? result : null;
}
// ── Skill linking helpers ───────────────────────────────────────────────────
function cleanupManagedSkillLinks(destDir, expectedNames, managedRoot) {
    if (!fs.existsSync(destDir))
        return;
    for (const entry of fs.readdirSync(destDir)) {
        if (expectedNames.has(entry))
            continue;
        const destPath = path.join(destDir, entry);
        try {
            const stat = fs.lstatSync(destPath);
            if (!stat.isSymbolicLink())
                continue;
            const target = fs.readlinkSync(destPath);
            const resolvedTarget = path.resolve(path.dirname(destPath), target);
            const managedPrefix = path.resolve(managedRoot) + path.sep;
            if (!resolvedTarget.startsWith(managedPrefix))
                continue;
            fs.unlinkSync(destPath);
        }
        catch (err) {
            if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                process.stderr.write(`[phren] cleanupManagedSkillLinks: ${errorMessage(err)}\n`);
        }
    }
}
export function linkSkillsDir(srcDir, destDir, managedRoot, symlinkFile, opts) {
    if (!fs.existsSync(srcDir))
        return;
    fs.mkdirSync(destDir, { recursive: true });
    const expectedNames = new Set();
    for (const entry of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, entry);
        const stat = fs.statSync(srcPath);
        const skillName = stat.isDirectory() ? entry : entry.replace(/\.md$/, "");
        if (opts?.phrenPath && opts.scope && !isSkillEnabled(opts.phrenPath, opts.scope, skillName)) {
            continue;
        }
        if (stat.isFile() && entry.endsWith(".md")) {
            expectedNames.add(entry);
            symlinkFile(srcPath, path.join(destDir, entry), managedRoot);
        }
        else if (stat.isDirectory()) {
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
export function writeSkillMd(phrenPath) {
    const lifecycle = buildSharedLifecycleCommands();
    const sessionStartCmd = lifecycle.sessionStart.replace(/"/g, '\\"');
    const promptCmd = lifecycle.userPromptSubmit.replace(/"/g, '\\"');
    const stopCmd = lifecycle.stop.replace(/"/g, '\\"');
    const version = VERSION;
    const toolCount = getToolCount();
    const toolCatalog = renderToolCatalogMarkdown();
    const content = `---
name: phren
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

# phren

Long-term memory for your AI agents. Injects relevant project context at the start of
each prompt and saves findings at session end via git. Works with Claude Code, Copilot CLI,
Cursor, Codex, and more.

## Lifecycle hooks

- **SessionStart**: pulls latest phren data and self-heals hook/symlink drift
- **UserPromptSubmit**: searches phren, injects matching context with trust filtering and token budgeting
- **Stop**: commits and pushes any phren changes to remote

## MCP tools (${toolCount})

${toolCatalog}

`;
    const dest = path.join(phrenPath, "phren.SKILL.md");
    fs.writeFileSync(dest, content);
}
