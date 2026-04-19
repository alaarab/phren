import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findPhrenPath, getProjectDirs } from "@phren/cli/paths";
import { resolveRuntimeProfile } from "@phren/cli/runtime-profile";
import { buildIndex } from "@phren/cli/shared";
import { searchKnowledgeRows, rankResults } from "@phren/cli/shared/retrieval";
import { readTasks } from "@phren/cli/data/tasks";
import { readFindings } from "@phren/cli/data/access";
/** Try to find phren path and detect the active project from cwd. */
export async function buildPhrenContext(projectOverride) {
    try {
        const phrenPath = findPhrenPath();
        if (!phrenPath || !fs.existsSync(phrenPath))
            return null;
        let profile = "";
        try {
            profile = resolveRuntimeProfile(phrenPath) ?? "";
        }
        catch { /* no profile */ }
        let project = projectOverride ?? null;
        if (!project) {
            try {
                const projectDirs = getProjectDirs(phrenPath, profile || undefined);
                const cwd = process.cwd();
                for (const dir of projectDirs) {
                    const name = path.basename(dir);
                    try {
                        const configPath = path.join(dir, "project.yaml");
                        if (fs.existsSync(configPath)) {
                            const content = fs.readFileSync(configPath, "utf-8");
                            const sourceMatch = content.match(/source:\s*(.+)/);
                            if (sourceMatch?.[1]) {
                                const sourcePath = sourceMatch[1].trim().replace(/^['"]|['"]$/g, "");
                                if (cwd.startsWith(sourcePath) || cwd === sourcePath) {
                                    project = name;
                                    break;
                                }
                            }
                        }
                    }
                    catch { /* skip */ }
                    if (path.basename(cwd) === name) {
                        project = name;
                        break;
                    }
                }
            }
            catch { /* no project detection */ }
        }
        return { phrenPath, profile, project };
    }
    catch {
        return null;
    }
}
/** Read truths.md pinned entries for a project. */
function readTruths(phrenPath, project) {
    try {
        const truthsPath = path.join(phrenPath, project, "truths.md");
        if (!fs.existsSync(truthsPath))
            return [];
        const content = fs.readFileSync(truthsPath, "utf-8");
        return content.split("\n").filter((line) => line.startsWith("- "));
    }
    catch {
        return [];
    }
}
const CLAUDE_MD_MAX_CHARS = 4000;
/**
 * Collect CLAUDE.md files by walking up from cwd to the filesystem root,
 * then checking the user-level ~/.claude/CLAUDE.md.
 * Returns entries most-specific first (cwd → parent → ... → user-level).
 */
function collectClaudeMdFiles() {
    const seen = new Set();
    const results = [];
    // Walk from cwd up to root
    let dir = process.cwd();
    while (true) {
        const candidate = path.join(dir, "CLAUDE.md");
        const resolved = path.resolve(candidate);
        if (!seen.has(resolved)) {
            seen.add(resolved);
            try {
                if (fs.existsSync(resolved)) {
                    const content = fs.readFileSync(resolved, "utf-8").trim();
                    if (content) {
                        results.push({ filePath: resolved, content });
                    }
                }
            }
            catch { /* skip unreadable */ }
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break; // reached root
        dir = parent;
    }
    // Check user-level ~/.claude/CLAUDE.md
    const userLevel = path.resolve(os.homedir(), ".claude", "CLAUDE.md");
    if (!seen.has(userLevel)) {
        seen.add(userLevel);
        try {
            if (fs.existsSync(userLevel)) {
                const content = fs.readFileSync(userLevel, "utf-8").trim();
                if (content) {
                    results.push({ filePath: userLevel, content });
                }
            }
        }
        catch { /* skip */ }
    }
    return results;
}
/** Build a context string from phren knowledge to inject into the system prompt. */
export async function buildContextSnippet(ctx, taskKeywords) {
    const sections = [];
    const label = ctx.project ?? "global";
    // Section 1: Pinned truths
    if (ctx.project) {
        try {
            const truths = readTruths(ctx.phrenPath, ctx.project);
            if (truths.length > 0) {
                sections.push(`## Pinned truths (${label})\n\n${truths.join("\n")}`);
            }
        }
        catch { /* silent */ }
    }
    // Section 2: Active tasks
    if (ctx.project) {
        try {
            const result = readTasks(ctx.phrenPath, ctx.project);
            if (result.ok && result.data) {
                const items = result.data.items;
                const lines = [];
                const active = items.Active?.slice(0, 5) ?? [];
                const queue = items.Queue?.slice(0, 3) ?? [];
                for (const t of active)
                    lines.push(`- [Active] ${t.line}`);
                for (const t of queue)
                    lines.push(`- [Queue] ${t.line}`);
                if (lines.length > 0) {
                    sections.push(`## Tasks (${label})\n\n${lines.join("\n")}`);
                }
            }
        }
        catch { /* silent */ }
    }
    // Section 3: Recent findings
    if (ctx.project) {
        try {
            const result = readFindings(ctx.phrenPath, ctx.project);
            if (result.ok && result.data) {
                const active = result.data
                    .filter((f) => f.status === "active" && f.tier !== "archived")
                    .slice(-5);
                if (active.length > 0) {
                    const lines = active.map((f) => `- ${f.text}`);
                    sections.push(`## Recent findings (${label})\n\n${lines.join("\n")}`);
                }
            }
        }
        catch { /* silent */ }
    }
    // Section 4: CLAUDE.md hierarchy (cwd → parent dirs → ~/.claude/CLAUDE.md)
    try {
        const claudeFiles = collectClaudeMdFiles();
        if (claudeFiles.length > 0) {
            let combined = claudeFiles
                .map((f) => `<!-- ${f.filePath} -->\n${f.content}`)
                .join("\n\n---\n\n");
            if (combined.length > CLAUDE_MD_MAX_CHARS) {
                combined = combined.slice(0, CLAUDE_MD_MAX_CHARS) + "\n\n<!-- truncated -->";
            }
            sections.push(`## CLAUDE.md\n\n${combined}`);
        }
    }
    catch { /* silent */ }
    // Section 5: FTS5 search
    try {
        const db = await buildIndex(ctx.phrenPath, ctx.profile || undefined);
        const result = await searchKnowledgeRows(db, {
            query: taskKeywords,
            maxResults: 10,
            filterProject: ctx.project || null,
            filterType: null,
            phrenPath: ctx.phrenPath,
        });
        const ranked = rankResults(result.rows ?? [], taskKeywords, null, ctx.project || null, ctx.phrenPath, db);
        if (ranked.length > 0) {
            const snippets = ranked.slice(0, 5).map((r) => {
                const content = r.content?.slice(0, 400) ?? "";
                return `[${r.project}/${r.filename}] ${content}`;
            });
            sections.push(`## Related knowledge (${label})\n\n${snippets.join("\n\n")}`);
        }
    }
    catch { /* silent */ }
    return sections.join("\n\n");
}
