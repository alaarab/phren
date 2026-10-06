import { createHash } from "node:crypto";
import { atomicWriteText } from "../phren-paths.js";
import { moduleSnapshot } from "../modules/runtime.js";
import { getRegisteredTools } from "../tool-registry.js";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { loadYamlDocument } from "../phren-core.js";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";
import { buildSharedLifecycleCommands } from "../hooks.js";
import { VERSION } from "../package-metadata.js";
import { getToolCount, renderToolCatalogMarkdown } from "../tool-registry.js";
import { readSkillEnabledState } from "../skill/state.js";
import { logger } from "../logger.js";
const REQUIRED_SKILL_FIELDS = ["name", "description"];
export function parseSkillFrontmatter(rawContent) {
    // Normalize UTF-8 BOM and Windows-style CRLF line endings before matching frontmatter
    const content = rawContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match)
        return { frontmatter: null, body: content };
    try {
        const parsed = loadYamlDocument(match[1], (text) => yaml.load(text));
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
/**
 * Returns true if `destPath` is a symlink whose resolved target lives under
 * `managedRoot`.  Used to decide whether phren owns a symlink.
 */
export function isManagedSymlink(destPath, managedRoot) {
    try {
        const stat = fs.lstatSync(destPath);
        if (!stat.isSymbolicLink())
            return false;
        const target = fs.readlinkSync(destPath);
        const resolvedTarget = path.resolve(path.dirname(destPath), target);
        const managedPrefix = path.resolve(managedRoot) + path.sep;
        return resolvedTarget.startsWith(managedPrefix);
    }
    catch {
        return false;
    }
}
/**
 * Returns true if `destPath` exists and is NOT a symlink that points into
 * managedRoot — i.e. it's a file/dir the user owns.
 */
function isUserOwnedFile(destPath, managedRoot) {
    try {
        fs.lstatSync(destPath);
    }
    catch {
        return false; // doesn't exist
    }
    return !isManagedSymlink(destPath, managedRoot);
}
/**
 * Scan destDir for files that phren would want to link (based on srcDir) but
 * can't because a user-owned file already occupies the destination slot.
 */
export function detectSkillCollisions(srcDir, destDir, managedRoot) {
    if (!fs.existsSync(srcDir) || !fs.existsSync(destDir))
        return [];
    const collisions = [];
    for (const entry of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, entry);
        const stat = fs.statSync(srcPath);
        if (stat.isFile() && entry.endsWith(".md")) {
            const destPath = path.join(destDir, entry);
            if (isUserOwnedFile(destPath, managedRoot)) {
                const skillName = entry.replace(/\.md$/, "");
                collisions.push({
                    skillName,
                    destPath,
                    message: `Skill '${skillName}' — user file already exists at ${destPath}. Rename or remove it to use phren's version.`,
                });
            }
        }
        else if (stat.isDirectory()) {
            const skillFile = path.join(srcPath, "SKILL.md");
            if (fs.existsSync(skillFile)) {
                const destPath = path.join(destDir, entry);
                if (isUserOwnedFile(destPath, managedRoot)) {
                    collisions.push({
                        skillName: entry,
                        destPath,
                        message: `Skill '${entry}' — user directory already exists at ${destPath}. Rename or remove it to use phren's version.`,
                    });
                }
            }
        }
    }
    return collisions;
}
function cleanupManagedSkillLinks(destDir, expectedNames, managedRoot) {
    if (!fs.existsSync(destDir))
        return;
    for (const entry of fs.readdirSync(destDir)) {
        if (expectedNames.has(entry))
            continue;
        const destPath = path.join(destDir, entry);
        try {
            if (!isManagedSymlink(destPath, managedRoot))
                continue;
            fs.unlinkSync(destPath);
        }
        catch (err) {
            logger.debug("link-skills", `cleanupManagedSkillLinks: ${errorMessage(err)}`);
        }
    }
}
export function linkSkillsDir(srcDir, destDir, managedRoot, symlinkFile, opts) {
    if (!fs.existsSync(srcDir))
        return [];
    fs.mkdirSync(destDir, { recursive: true });
    const expectedNames = new Set();
    const collisions = [];
    const isEnabled = opts?.phrenPath && opts.scope ? readSkillEnabledState(opts.phrenPath) : undefined;
    for (const entry of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, entry);
        const stat = fs.statSync(srcPath);
        const skillName = stat.isDirectory() ? entry : entry.replace(/\.md$/, "");
        if (isEnabled && opts?.scope && !isEnabled(opts.scope, skillName)) {
            continue;
        }
        if (stat.isFile() && entry.endsWith(".md")) {
            const destPath = path.join(destDir, entry);
            if (isUserOwnedFile(destPath, managedRoot)) {
                const collision = {
                    skillName,
                    destPath,
                    message: `Skipping skill '${skillName}' — user skill already exists at ${destPath}. To use phren's version, rename or remove your skill first.`,
                };
                collisions.push(collision);
                logger.warn("link-skills", collision.message);
                continue;
            }
            expectedNames.add(entry);
            symlinkFile(srcPath, destPath, managedRoot);
        }
        else if (stat.isDirectory()) {
            const skillFile = path.join(srcPath, "SKILL.md");
            if (fs.existsSync(skillFile)) {
                const destPath = path.join(destDir, entry);
                if (isUserOwnedFile(destPath, managedRoot)) {
                    const collision = {
                        skillName,
                        destPath,
                        message: `Skipping skill '${skillName}' — user skill already exists at ${destPath}. To use phren's version, rename or remove your skill first.`,
                    };
                    collisions.push(collision);
                    logger.warn("link-skills", collision.message);
                    continue;
                }
                expectedNames.add(entry);
                // Symlink the entire skill directory so bundled scripts and assets are accessible.
                // Relative paths in the skill body remain valid because the directory structure is preserved.
                symlinkFile(srcPath, destPath, managedRoot);
            }
        }
    }
    cleanupManagedSkillLinks(destDir, expectedNames, managedRoot);
    return collisions;
}
export function writeSkillMd(phrenPath) {
    const lifecycle = buildSharedLifecycleCommands();
    const sessionStartCmd = lifecycle.sessionStart.replace(/"/g, '\\"');
    const promptCmd = lifecycle.userPromptSubmit.replace(/"/g, '\\"');
    const stopCmd = lifecycle.stop.replace(/"/g, '\\"');
    const version = VERSION;
    const allowed = new Set(moduleSnapshot(phrenPath).modules.flatMap(module => module.tools.map(tool => tool.name)));
    const excluded = getRegisteredTools().filter(tool => !allowed.has(tool.name));
    const toolCount = getToolCount() - excluded.length;
    const toolCatalog = excluded.length ? renderToolCatalogMarkdown(allowed) : renderToolCatalogMarkdown();
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
          timeout: 10
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
    const ledger = path.join(phrenPath, ".runtime", "module-skill.sha256");
    const digest = (text) => createHash("sha256").update(text).digest("hex");
    const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink())
            return;
        const existing = fs.readFileSync(dest, "utf8");
        const previous = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").trim() : "";
        const legacy = content.replace(`## MCP tools (${toolCount})\n\n${toolCatalog}`, `## MCP tools (${getToolCount()})\n\n${renderToolCatalogMarkdown()}`);
        if (existing !== content && existing !== legacy && digest(existing) !== previous)
            return;
    }
    atomicWriteText(dest, content);
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    atomicWriteText(ledger, digest(content) + "\n");
}
