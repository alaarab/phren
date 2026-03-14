import * as fs from "fs";
import * as path from "path";
import { capCache } from "./shared.js";
// ── Glob matching and project frontmatter ────────────────────────────────────
const projectGlobCache = new Map();
export function clearProjectGlobCache() {
    projectGlobCache.clear();
}
function parseProjectGlobs(phrenPathLocal, project) {
    if (projectGlobCache.has(project))
        return projectGlobCache.get(project);
    const claudeMdPath = path.join(phrenPathLocal, project, "CLAUDE.md");
    let globs = null;
    try {
        if (fs.existsSync(claudeMdPath)) {
            const raw = fs.readFileSync(claudeMdPath, "utf8");
            const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
                const fmBlock = fmMatch[1];
                const globLine = fmBlock.match(/^globs:\s*$/m);
                if (globLine) {
                    const lines = fmBlock.split("\n");
                    const idx = lines.findIndex((l) => /^globs:\s*$/.test(l));
                    if (idx >= 0) {
                        const items = [];
                        for (let i = idx + 1; i < lines.length; i++) {
                            const m = lines[i].match(/^\s+-\s+(.+)/);
                            if (m)
                                items.push(m[1].trim().replace(/^["']|["']$/g, ""));
                            else
                                break;
                        }
                        if (items.length > 0)
                            globs = items;
                    }
                }
                else {
                    const inlineMatch = fmBlock.match(/^globs:\s*\[([^\]]+)\]/m);
                    if (inlineMatch) {
                        globs = inlineMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
                    }
                }
            }
        }
    }
    catch (err) {
        if (process.env.PHREN_DEBUG)
            process.stderr.write(`[phren] getProjectGlobs: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    projectGlobCache.set(project, globs);
    capCache(projectGlobCache);
    return globs;
}
function simpleGlobMatch(pattern, filePath) {
    const normalized = filePath.replace(/\\/g, "/");
    const regex = pattern
        .replace(/\\/g, "/")
        .replace(/[.+^${}()|[\]]/g, "\\$&")
        .replace(/\*\*/g, "\0")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\0/g, ".*");
    return new RegExp(`^${regex}$`).test(normalized) || new RegExp(`(^|/)${regex}$`).test(normalized);
}
export function getProjectGlobBoost(phrenPathLocal, project, cwd, changedFiles) {
    const globs = parseProjectGlobs(phrenPathLocal, project);
    if (!globs)
        return 1.0;
    const paths = [];
    if (cwd)
        paths.push(cwd);
    if (changedFiles) {
        for (const f of changedFiles)
            paths.push(f);
    }
    for (const p of paths) {
        for (const glob of globs) {
            if (simpleGlobMatch(glob, p))
                return 1.3;
        }
    }
    return 0.7;
}
