/**
 * Teardown helpers: remove phren-owned symlinks, wrappers, and repo mirrors.
 *
 * Shared by `phren uninstall` and `phren preset` downgrades. Everything here
 * only ever removes artifacts phren itself created — symlinks that resolve into
 * the store, wrappers carrying the phren marker, and `.git/info/exclude` lines
 * under the phren-managed marker. User-owned files are never touched.
 */
import * as fs from "fs";
import * as path from "path";
import { homeDir, homePath, getProjectDirs } from "../phren-paths.js";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";
import { log } from "./shared.js";
import { FINDINGS_FILENAME } from "../data/access.js";
import { getProjectOwnershipMode, readProjectConfig } from "../project-config.js";
import { findProjectDir } from "../project-locator.js";
function agentSkillDirs() {
    const home = homeDir();
    return [
        homePath(".claude", "skills"),
        path.join(home, ".cursor", "skills"),
        path.join(home, ".copilot", "skills"),
        path.join(home, ".codex", "skills"),
    ];
}
export function generatedRootMemoryPath() {
    const home = homeDir();
    const key = home.replace(/[/\\:]/g, "-").replace(/^-/, "");
    return path.join(home, ".claude", "projects", key, "memory", "MEMORY.md");
}
/** Remove only complete managed blocks; surrounding notes and unmarked files survive. */
export function removeGeneratedHomeFiles() {
    const changed = [];
    const targets = [
        { file: homePath(".phren-context.md"), start: "<!-- phren-managed -->", end: "<!-- phren-managed -->" },
        { file: generatedRootMemoryPath(), start: "<!-- phren:projects:start -->", end: "<!-- phren:projects:end -->" },
    ];
    for (const { file, start, end } of targets) {
        try {
            // A symlink may point at a user's unrelated file, even if it has a marker.
            if (!fs.existsSync(file) || !fs.lstatSync(file).isFile())
                continue;
            const content = fs.readFileSync(file, "utf8");
            const first = content.indexOf(start);
            const last = content.indexOf(end, first + start.length);
            if (first < 0 || last < 0)
                continue;
            let remaining = content.slice(0, first) + content.slice(last + end.length);
            // This exact introduction is generated alongside the root projects block.
            // Custom introductions and any notes following the block remain intact.
            const generatedIntros = [
                "# Root Memory\n\n## Machine Context\nRead `~/.phren-context.md` for profile, active projects, and sync metadata.\n\n",
                "# Root Memory\n\n## Machine Context\nRead `~/.phren-context.md` for profile, active projects, last sync date.\n\n## Cross-Project Notes\n- Read a project's AGENTS.md before making changes.\n- Per-project memory files (MEMORY-{name}.md) have commands, versions, findings.\n\n",
            ];
            if (file === generatedRootMemoryPath()) {
                const introduction = generatedIntros.find((intro) => remaining.startsWith(intro));
                if (introduction)
                    remaining = remaining.slice(introduction.length);
            }
            if (remaining.trim())
                fs.writeFileSync(file, remaining);
            else
                fs.unlinkSync(file);
            changed.push(file);
            log(`  Removed phren-managed content: ${file}`);
        }
        catch (err) {
            debugLog(`removeGeneratedHomeFiles: cleanup failed for ${file}: ${errorMessage(err)}`);
        }
    }
    return changed;
}
/** Remove the phren-owned ~/.claude/CLAUDE.md and copilot-instructions.md symlinks. */
export function removePhrenHomeSymlinks() {
    const removed = [];
    for (const link of [homePath(".claude", "CLAUDE.md"), homePath(".github", "copilot-instructions.md")]) {
        try {
            if (fs.lstatSync(link).isSymbolicLink()) {
                fs.unlinkSync(link);
                log(`  Removed symlink: ${link}`);
                removed.push(link);
            }
        }
        catch {
            // Missing or a regular file (user-owned) — leave it alone.
        }
    }
    return removed;
}
/** Remove ~/.local/bin/{copilot,cursor,codex,phren} wrappers that carry the phren marker. */
export function removePhrenWrappers() {
    const removed = [];
    const localBinDir = path.join(homeDir(), ".local", "bin");
    for (const tool of ["copilot", "cursor", "codex", "phren"]) {
        const wrapperPath = path.join(localBinDir, tool);
        try {
            if (fs.existsSync(wrapperPath)) {
                const content = fs.readFileSync(wrapperPath, "utf8");
                if (content.includes("PHREN_PATH") && content.includes("phren")) {
                    fs.unlinkSync(wrapperPath);
                    log(`  Removed ${tool} wrapper (${wrapperPath})`);
                    removed.push(wrapperPath);
                }
            }
        }
        catch (err) {
            debugLog(`removePhrenWrappers: cleanup failed for ${wrapperPath}: ${errorMessage(err)}`);
        }
    }
    return removed;
}
/** Remove skill symlinks in agent skill dirs that resolve into the phren store, plus manifests. */
export function sweepAgentSkillSymlinks(phrenPath) {
    const resolvedPhren = path.resolve(phrenPath);
    for (const dir of agentSkillDirs()) {
        if (!fs.existsSync(dir))
            continue;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch (err) {
            debugLog(`sweepAgentSkillSymlinks: readdirSync failed for ${dir}: ${errorMessage(err)}`);
            continue;
        }
        for (const entry of entries) {
            if (!entry.isSymbolicLink())
                continue;
            const fullPath = path.join(dir, entry.name);
            try {
                const target = fs.realpathSync(fullPath);
                if (target.startsWith(resolvedPhren + path.sep) || target === resolvedPhren) {
                    fs.unlinkSync(fullPath);
                    log(`  Removed skill symlink: ${fullPath}`);
                }
            }
            catch {
                // Broken symlink — only remove it if it clearly pointed into the store.
                try {
                    const raw = fs.readlinkSync(fullPath);
                    const resolved = path.resolve(dir, raw);
                    if (resolved.startsWith(resolvedPhren + path.sep) || resolved === resolvedPhren) {
                        fs.unlinkSync(fullPath);
                        log(`  Removed broken skill symlink: ${fullPath}`);
                    }
                }
                catch (err2) {
                    debugLog(`sweepAgentSkillSymlinks: could not inspect ${fullPath}: ${errorMessage(err2)}`);
                }
            }
        }
        const parentDir = path.dirname(dir);
        for (const manifestFile of ["skill-manifest.json", "skill-commands.json"]) {
            const manifestPath = path.join(parentDir, manifestFile);
            try {
                if (fs.existsSync(manifestPath)) {
                    fs.unlinkSync(manifestPath);
                    log(`  Removed ${manifestFile} (${manifestPath})`);
                }
            }
            catch (err) {
                debugLog(`sweepAgentSkillSymlinks: could not remove ${manifestPath}: ${errorMessage(err)}`);
            }
        }
    }
}
/** Remove the given exclude entries (and the phren-managed marker) from a repo's .git/info/exclude. */
export function removeGitExcludes(projectDir, entries) {
    const excludePath = path.join(projectDir, ".git", "info", "exclude");
    if (!fs.existsSync(excludePath))
        return;
    try {
        const removeSet = new Set(entries);
        const lines = fs.readFileSync(excludePath, "utf8").split("\n");
        const kept = lines.filter((line) => {
            const trimmed = line.trim();
            if (trimmed === "# phren-managed")
                return false;
            return !removeSet.has(trimmed);
        });
        // Collapse any trailing blank lines we may have introduced.
        while (kept.length > 1 && kept[kept.length - 1].trim() === "" && kept[kept.length - 2].trim() === "") {
            kept.pop();
        }
        const next = kept.join("\n");
        if (next !== lines.join("\n")) {
            fs.writeFileSync(excludePath, next.endsWith("\n") || next === "" ? next : next + "\n");
            log(`  Cleaned phren entries from ${excludePath}`);
        }
    }
    catch (err) {
        debugLog(`removeGitExcludes: failed for ${projectDir}: ${errorMessage(err)}`);
    }
}
/**
 * Remove per-project repo mirror symlinks (AGENTS.md, REFERENCE.md, findings,
 * AGENTS.md, CLAUDE-*.md, .github/copilot-instructions.md, .claude/skills/*) that
 * phren created in phren-managed repos, and strip the matching exclude lines.
 * Only removes symlinks that resolve back into the phren store.
 */
export function sweepProjectMirrors(phrenPath) {
    const resolvedPhren = path.resolve(phrenPath);
    const resolvesIntoStore = (p) => {
        try {
            const target = fs.realpathSync(p);
            return target.startsWith(resolvedPhren + path.sep) || target === resolvedPhren;
        }
        catch {
            // Broken symlink — check its raw (unresolved) target.
            try {
                const raw = fs.readlinkSync(p);
                const resolved = path.resolve(path.dirname(p), raw);
                return resolved.startsWith(resolvedPhren + path.sep) || resolved === resolvedPhren;
            }
            catch {
                return false;
            }
        }
    };
    for (const projectDir of getProjectDirs(phrenPath)) {
        const project = path.basename(projectDir);
        if (project === "global")
            continue;
        let ownership;
        try {
            const config = readProjectConfig(phrenPath, project);
            ownership = getProjectOwnershipMode(phrenPath, project, config);
        }
        catch (err) {
            debugLog(`sweepProjectMirrors: config read failed for ${project}: ${errorMessage(err)}`);
            continue;
        }
        if (ownership !== "phren-managed")
            continue;
        const repo = findProjectDir(project);
        if (!repo || !fs.existsSync(repo))
            continue;
        const removedEntries = [];
        const removeMirror = (relPath) => {
            const full = path.join(repo, relPath);
            let stat;
            try {
                stat = fs.lstatSync(full);
            }
            catch {
                return;
            }
            if (!stat.isSymbolicLink())
                return;
            if (!resolvesIntoStore(full))
                return;
            try {
                fs.unlinkSync(full);
                log(`  Removed repo mirror: ${full}`);
                removedEntries.push(relPath);
            }
            catch (err) {
                debugLog(`sweepProjectMirrors: could not remove ${full}: ${errorMessage(err)}`);
            }
        };
        // Fixed mirror files.
        for (const f of ["AGENTS.md", "CLAUDE.md", "REFERENCE.md", FINDINGS_FILENAME, path.join(".github", "copilot-instructions.md")]) {
            removeMirror(f);
        }
        // CLAUDE-*.md split files.
        try {
            for (const f of fs.readdirSync(repo)) {
                if (/^CLAUDE-.+\.md$/.test(f))
                    removeMirror(f);
            }
        }
        catch { /* repo unreadable — skip */ }
        // Project skill symlinks under .claude/skills.
        const skillsDir = path.join(repo, ".claude", "skills");
        if (fs.existsSync(skillsDir)) {
            try {
                for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
                    if (entry.isSymbolicLink())
                        removeMirror(path.join(".claude", "skills", entry.name));
                }
            }
            catch { /* skills dir unreadable — skip */ }
        }
        if (removedEntries.length > 0)
            removeGitExcludes(repo, removedEntries);
    }
}
