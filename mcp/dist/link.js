import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as readline from "readline";
import * as yaml from "js-yaml";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { configureClaude, configureCodexMcp, configureCopilotMcp, configureCursorMcp, configureVSCode, ensureGovernanceFiles, getHooksEnabledPreference, getMcpEnabledPreference, isVersionNewer, logMcpTargetStatus, patchJsonFile, setMcpEnabledPreference, } from "./init.js";
import { configureAllHooks, detectInstalledTools } from "./hooks.js";
import { getMachineName, persistMachineName } from "./machine-identity.js";
import { debugLog, EXEC_TIMEOUT_MS, EXEC_TIMEOUT_QUICK_MS, isRecord, homePath, hookConfigPath, installPreferencesFile, } from "./shared.js";
import { errorMessage } from "./utils.js";
import { listMachines as listMachinesShared, listProfiles as listProfilesShared, setMachineProfile, } from "./profile-store.js";
import { writeSkillMd } from "./link-skills.js";
import { syncScopeSkillsToDir } from "./skill-files.js";
import { renderSkillInstructionsSection } from "./skill-registry.js";
import { findProjectDir } from "./project-locator.js";
import { getProjectOwnershipMode, readProjectConfig, } from "./project-config.js";
import { writeContextDefault, writeContextDebugging, writeContextPlanning, writeContextClean, readBackNativeMemory, rebuildMemory, } from "./link-context.js";
// Re-export sub-modules so existing imports from "./link.js" continue to work
export { runDoctor } from "./link-doctor.js";
export { updateFileChecksums, verifyFileChecksums } from "./link-checksums.js";
export { findProjectDir } from "./project-locator.js";
export { parseSkillFrontmatter, validateSkillFrontmatter, validateSkillsDir, readSkillManifestHooks, } from "./link-skills.js";
// ── Helpers (exported for link-doctor) ──────────────────────────────────────
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function log(msg) { process.stdout.write(msg + "\n"); }
function atomicWriteText(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
}
export { getMachineName } from "./machine-identity.js";
export function lookupProfile(phrenPath, machine) {
    const listed = listMachinesShared(phrenPath);
    if (!listed.ok)
        return "";
    return listed.data[machine] || "";
}
function listProfiles(phrenPath) {
    const listed = listProfilesShared(phrenPath);
    if (!listed.ok)
        return [];
    return listed.data.map((profile) => ({ name: profile.name, description: "" }));
}
export function findProfileFile(phrenPath, profileName) {
    const profilesDir = path.join(phrenPath, "profiles");
    if (!fs.existsSync(profilesDir))
        return null;
    for (const f of fs.readdirSync(profilesDir)) {
        if (!f.endsWith(".yaml"))
            continue;
        const data = yaml.load(fs.readFileSync(path.join(profilesDir, f), "utf8"), { schema: yaml.CORE_SCHEMA });
        if (data?.name === profileName)
            return path.join(profilesDir, f);
    }
    return null;
}
export function getProfileProjects(profileFile) {
    const data = yaml.load(fs.readFileSync(profileFile, "utf8"), { schema: yaml.CORE_SCHEMA });
    return Array.isArray(data?.projects) ? data.projects : [];
}
function currentPackageVersion() {
    try {
        const pkgPath = path.join(ROOT, "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        return pkg.version || null;
    }
    catch (err) {
        debugLog(`currentPackageVersion: failed to read package.json: ${errorMessage(err)}`);
        return null;
    }
}
function maybeOfferStarterTemplateUpdate(phrenPath) {
    const current = currentPackageVersion();
    if (!current)
        return;
    const prefsPath = installPreferencesFile(phrenPath);
    if (!fs.existsSync(prefsPath))
        return;
    try {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
        if (isVersionNewer(current, prefs.installedVersion)) {
            log(`  Starter template update available: v${prefs.installedVersion} -> v${current}`);
            log(`  Run \`npx phren init --apply-starter-update\` to refresh global/CLAUDE.md and global skills.`);
        }
    }
    catch (err) {
        debugLog(`checkStarterVersionUpdate: failed to read preferences: ${errorMessage(err)}`);
    }
}
// ── Machine registration ────────────────────────────────────────────────────
async function registerMachine(phrenPath) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));
    log("This machine isn't registered with phren yet.\n");
    const machine = (await ask("What should this machine be called? (e.g. work-desktop): ")).trim();
    if (!machine) {
        rl.close();
        throw new Error("Machine name can't be empty.");
    }
    log("\nAvailable profiles:");
    for (const p of listProfiles(phrenPath))
        log(`  ${p.name}  (${p.description})`);
    log("");
    const profile = (await ask("Which profile? ")).trim();
    rl.close();
    if (!profile)
        throw new Error("Profile name can't be empty.");
    if (!findProfileFile(phrenPath, profile))
        throw new Error(`No profile named '${profile}' found.`);
    const mapResult = setMachineProfile(phrenPath, machine, profile);
    if (!mapResult.ok)
        throw new Error(mapResult.error);
    persistMachineName(machine);
    log(`\nRegistered ${machine} with profile ${profile}.`);
    return { machine, profile };
}
// ── Sparse checkout ─────────────────────────────────────────────────────────
function setupSparseCheckout(phrenPath, projects) {
    try {
        execFileSync("git", ["rev-parse", "--git-dir"], { cwd: phrenPath, stdio: "ignore", timeout: EXEC_TIMEOUT_QUICK_MS });
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] setupSparseCheckout notAGitRepo: ${errorMessage(err)}\n`);
        return;
    }
    const alwaysInclude = ["profiles", "machines.yaml", "global", "scripts", "link.sh", "README.md", ".gitignore"];
    const paths = [...alwaysInclude, ...projects];
    try {
        execFileSync("git", ["sparse-checkout", "set", ...paths], { cwd: phrenPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
        execFileSync("git", ["pull", "--ff-only"], { cwd: phrenPath, stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
    }
    catch (err) {
        debugLog(`setupSparseCheckout: git sparse-checkout or pull failed: ${errorMessage(err)}`);
    }
}
// ── Symlink helpers ─────────────────────────────────────────────────────────
/** Add entries to .git/info/exclude so phren-managed symlinks don't pollute git status.
 *  Skips files already tracked by git to avoid hiding user-owned content. */
function addGitExcludes(projectDir, entries) {
    const gitDir = path.join(projectDir, ".git");
    if (!fs.existsSync(gitDir))
        return;
    try {
        // Filter out files already tracked by git — exclude only affects untracked files,
        // and adding tracked files could confuse users who version-control their own CLAUDE.md
        let tracked;
        try {
            const out = execFileSync("git", ["ls-files", "--", ...entries], {
                cwd: projectDir,
                timeout: EXEC_TIMEOUT_QUICK_MS,
                encoding: "utf8",
            });
            tracked = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
        }
        catch {
            tracked = new Set();
        }
        const safe = entries.filter((e) => !tracked.has(e));
        if (safe.length === 0)
            return;
        const excludePath = path.join(gitDir, "info", "exclude");
        fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
        const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
        const existingLines = new Set(existing.split("\n").map((l) => l.trim()));
        const toAdd = safe.filter((e) => !existingLines.has(e));
        if (toAdd.length === 0)
            return;
        const marker = "# phren-managed";
        const needsMarker = !existingLines.has(marker);
        const suffix = (needsMarker ? `\n${marker}\n` : "\n") + toAdd.join("\n") + "\n";
        fs.appendFileSync(excludePath, suffix);
    }
    catch {
        // git not available or fs issue — silently skip
    }
}
function symlinkFile(src, dest, managedRoot) {
    try {
        const stat = fs.lstatSync(dest);
        if (stat.isSymbolicLink()) {
            const currentTarget = fs.readlinkSync(dest);
            const resolvedTarget = path.resolve(path.dirname(dest), currentTarget);
            const managedPrefix = path.resolve(managedRoot) + path.sep;
            if (resolvedTarget === path.resolve(src))
                return true;
            if (!resolvedTarget.startsWith(managedPrefix)) {
                log(`  preserve existing symlink: ${dest}`);
                return false;
            }
            fs.unlinkSync(dest);
        }
        else {
            try {
                if (stat.isFile() && fs.readFileSync(dest, "utf8") === fs.readFileSync(src, "utf8")) {
                    fs.unlinkSync(dest);
                }
                else {
                    const kind = stat.isDirectory() ? "directory" : "file";
                    log(`  preserve existing ${kind}: ${dest}`);
                    return false;
                }
            }
            catch {
                log(`  preserve existing file: ${dest}`);
                return false;
            }
        }
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw err;
    }
    fs.symlinkSync(src, dest);
    return true;
}
function addTokenAnnotation(filePath) {
    const content = fs.readFileSync(filePath, "utf8");
    if (content.startsWith("<!-- tokens:"))
        return;
    const tokens = Math.round(content.length / 3.5 + (content.match(/\s+/g) || []).length * 0.1);
    if (tokens <= 500)
        return;
    const rounded = Math.round((tokens + 50) / 100) * 100;
    atomicWriteText(filePath, `<!-- tokens: ~${rounded} -->\n${content}`);
}
const GENERATED_AGENTS_MARKER = "<!-- phren:generated-agents -->";
function writeManagedAgentsFile(src, dest, content, managedRoot) {
    try {
        const stat = fs.lstatSync(dest);
        if (stat.isDirectory()) {
            log(`  preserve existing directory: ${dest}`);
            return false;
        }
        if (stat.isSymbolicLink()) {
            const currentTarget = fs.readlinkSync(dest);
            const resolvedTarget = path.resolve(path.dirname(dest), currentTarget);
            const managedPrefix = path.resolve(managedRoot) + path.sep;
            if (resolvedTarget === path.resolve(src) || resolvedTarget.startsWith(managedPrefix)) {
                fs.unlinkSync(dest);
            }
            else {
                log(`  preserve existing file: ${dest}`);
                return false;
            }
        }
        else {
            const existing = fs.readFileSync(dest, "utf8");
            if (!existing.includes(GENERATED_AGENTS_MARKER)) {
                log(`  preserve existing file: ${dest}`);
                return false;
            }
            fs.unlinkSync(dest);
        }
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw err;
    }
    atomicWriteText(dest, `${content.trimEnd()}\n`);
    return true;
}
// ── Linking operations ──────────────────────────────────────────────────────
function linkGlobal(phrenPath, tools) {
    log("  global skills -> ~/.claude/skills/");
    const skillsDir = homePath(".claude", "skills");
    syncScopeSkillsToDir(phrenPath, "global", skillsDir);
    const globalClaude = path.join(phrenPath, "global", "CLAUDE.md");
    if (fs.existsSync(globalClaude)) {
        symlinkFile(globalClaude, homePath(".claude", "CLAUDE.md"), phrenPath);
        if (tools.has("copilot")) {
            try {
                const copilotInstrDir = homePath(".github");
                fs.mkdirSync(copilotInstrDir, { recursive: true });
                symlinkFile(globalClaude, path.join(copilotInstrDir, "copilot-instructions.md"), phrenPath);
            }
            catch (err) {
                if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                    process.stderr.write(`[phren] linkGlobal copilotInstructions: ${errorMessage(err)}\n`);
            }
        }
    }
}
function linkProject(phrenPath, project, tools) {
    const config = readProjectConfig(phrenPath, project);
    const ownership = getProjectOwnershipMode(phrenPath, project, config);
    const target = findProjectDir(project);
    if (!target && ownership === "phren-managed") {
        log(`  skip ${project} (not found on disk)`);
        if (isRecord(config.mcpServers)) {
            linkProjectMcpServers(project, config.mcpServers);
        }
        return;
    }
    if (ownership !== "phren-managed") {
        if (target) {
            log(`  ${project} -> ${target} (${ownership}, repo mirrors disabled)`);
        }
        else {
            log(`  ${project} (${ownership}, repo mirrors disabled)`);
        }
        if (isRecord(config.mcpServers)) {
            linkProjectMcpServers(project, config.mcpServers);
        }
        return;
    }
    if (!target)
        return;
    log(`  ${project} -> ${target}`);
    const excludeEntries = [];
    for (const f of ["CLAUDE.md", "REFERENCE.md", "FINDINGS.md"]) {
        const src = path.join(phrenPath, project, f);
        if (fs.existsSync(src)) {
            if (symlinkFile(src, path.join(target, f), phrenPath))
                excludeEntries.push(f);
            if (f === "CLAUDE.md") {
                if (tools.has("copilot")) {
                    try {
                        const copilotDir = path.join(target, ".github");
                        fs.mkdirSync(copilotDir, { recursive: true });
                        symlinkFile(src, path.join(copilotDir, "copilot-instructions.md"), phrenPath);
                    }
                    catch (err) {
                        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                            process.stderr.write(`[phren] linkProject copilotInstructions: ${errorMessage(err)}\n`);
                    }
                }
            }
        }
    }
    // CLAUDE-*.md split files
    const projectDir = path.join(phrenPath, project);
    if (fs.existsSync(projectDir)) {
        for (const f of fs.readdirSync(projectDir)) {
            if (/^CLAUDE-.+\.md$/.test(f)) {
                if (symlinkFile(path.join(projectDir, f), path.join(target, f), phrenPath))
                    excludeEntries.push(f);
            }
        }
    }
    // Token annotation on CLAUDE.md
    const claudeFile = path.join(phrenPath, project, "CLAUDE.md");
    if (fs.existsSync(claudeFile)) {
        try {
            addTokenAnnotation(claudeFile);
        }
        catch (err) {
            if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                process.stderr.write(`[phren] linkProject tokenAnnotation: ${errorMessage(err)}\n`);
        }
    }
    // Project-level skills
    const targetSkills = path.join(target, ".claude", "skills");
    const skillManifest = config.skills !== false
        ? syncScopeSkillsToDir(phrenPath, project, targetSkills)
        : undefined;
    if (tools.has("codex") && fs.existsSync(claudeFile)) {
        try {
            const manifest = skillManifest || syncScopeSkillsToDir(phrenPath, project, targetSkills);
            const agentsContent = `${fs.readFileSync(claudeFile, "utf8").trimEnd()}\n\n${GENERATED_AGENTS_MARKER}\n${renderSkillInstructionsSection(manifest)}\n`;
            if (writeManagedAgentsFile(claudeFile, path.join(target, "AGENTS.md"), agentsContent, phrenPath))
                excludeEntries.push("AGENTS.md");
        }
        catch (err) {
            if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                process.stderr.write(`[phren] linkProject agentsMd: ${errorMessage(err)}\n`);
        }
    }
    // Auto-exclude phren-managed files from git status
    if (excludeEntries.length > 0)
        addGitExcludes(target, excludeEntries);
    // Per-project MCP servers
    if (isRecord(config.mcpServers)) {
        linkProjectMcpServers(project, config.mcpServers);
    }
}
/**
 * Merge per-project MCP servers into Claude's settings.json.
 * Keys are namespaced as "phren__<project>__<name>" so we can identify
 * and clean them up without touching user-managed servers.
 */
function linkProjectMcpServers(project, servers) {
    const settingsPath = hookConfigPath("claude");
    if (!fs.existsSync(settingsPath) && Object.keys(servers).length === 0)
        return;
    try {
        patchJsonFile(settingsPath, (data) => {
            const mcpServers = isRecord(data.mcpServers) ? data.mcpServers : (data.mcpServers = {});
            // Remove stale entries for this project (keys we previously wrote)
            for (const key of Object.keys(mcpServers)) {
                if (key.startsWith(`phren__${project}__`))
                    delete mcpServers[key];
            }
            // Add current entries
            for (const [name, entry] of Object.entries(servers)) {
                const key = `phren__${project}__${name}`;
                const server = { command: entry.command };
                if (Array.isArray(entry.args))
                    server.args = entry.args;
                if (entry.env && typeof entry.env === "object")
                    server.env = entry.env;
                mcpServers[key] = server;
            }
        });
    }
    catch (err) {
        debugLog(`linkProjectMcpServers: failed for ${project}: ${errorMessage(err)}`);
    }
}
/** Remove any phren__<project>__* MCP entries for projects no longer in the active set. */
function pruneStaleProjectMcpServers(activeProjects) {
    const settingsPath = hookConfigPath("claude");
    if (!fs.existsSync(settingsPath))
        return;
    try {
        patchJsonFile(settingsPath, (data) => {
            const mcpServers = isRecord(data.mcpServers) ? data.mcpServers : undefined;
            if (!mcpServers)
                return;
            for (const key of Object.keys(mcpServers)) {
                if (!key.startsWith("phren__"))
                    continue;
                // Key format: phren__<project>__<name>
                const parts = key.split("__");
                if (parts.length < 3)
                    continue;
                const project = parts[1];
                if (!activeProjects.includes(project)) {
                    delete mcpServers[key];
                    debugLog(`pruneStaleProjectMcpServers: removed stale entry "${key}"`);
                }
            }
        });
    }
    catch (err) {
        debugLog(`pruneStaleProjectMcpServers: failed: ${errorMessage(err)}`);
    }
}
// ── Main orchestrator ───────────────────────────────────────────────────────
export async function runLink(phrenPath, opts = {}) {
    log("phren link\n");
    ensureGovernanceFiles(phrenPath);
    // Step 1: Identify machine + profile
    let machine = opts.machine ?? getMachineName();
    let profile = "";
    if (opts.profile) {
        profile = opts.profile;
    }
    else if (opts.register) {
        const reg = await registerMachine(phrenPath);
        machine = reg.machine;
        profile = reg.profile;
    }
    else {
        profile = lookupProfile(phrenPath, machine);
        if (!profile) {
            const reg = await registerMachine(phrenPath);
            machine = reg.machine;
            profile = reg.profile;
        }
    }
    if (!profile)
        throw new Error(`Could not determine profile for machine '${machine}'.`);
    persistMachineName(machine);
    // Step 2: Find profile file
    const profileFile = findProfileFile(phrenPath, profile);
    if (!profileFile)
        throw new Error(`Profile '${profile}' not found in profiles/.`);
    log(`Machine: ${machine}`);
    log(`Profile: ${profile} (${profileFile})\n`);
    // Step 3: Read projects
    const projects = getProfileProjects(profileFile);
    if (!projects.length)
        throw new Error(`Profile '${profile}' has no projects listed.`);
    // Step 4: Sparse checkout
    log("Setting up sparse checkout...");
    setupSparseCheckout(phrenPath, projects);
    log("");
    // Detect installed tools once
    const detectedTools = opts.allTools
        ? new Set(["copilot", "cursor", "codex"])
        : detectInstalledTools();
    // Step 5: Symlink
    log("Linking...");
    linkGlobal(phrenPath, detectedTools);
    for (const p of projects) {
        if (p !== "global")
            linkProject(phrenPath, p, detectedTools);
    }
    // Remove stale phren__<project>__* MCP entries for removed projects
    pruneStaleProjectMcpServers(projects.filter(p => p !== "global"));
    log("");
    // Step 6: Configure MCP
    log("Configuring MCP...");
    const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(phrenPath);
    const hooksEnabled = getHooksEnabledPreference(phrenPath);
    setMcpEnabledPreference(phrenPath, mcpEnabled);
    log(`  MCP mode: ${mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)"}`);
    log(`  Hooks mode: ${hooksEnabled ? "ON (active)" : "OFF (disabled)"}`);
    maybeOfferStarterTemplateUpdate(phrenPath);
    let mcpStatus = "no_settings";
    try {
        mcpStatus = configureClaude(phrenPath, { mcpEnabled, hooksEnabled }) ?? "installed";
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] link configureClaude: ${errorMessage(err)}\n`);
    }
    logMcpTargetStatus("Claude", mcpStatus);
    let vsStatus = "no_vscode";
    try {
        vsStatus = configureVSCode(phrenPath, { mcpEnabled }) ?? "no_vscode";
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] link configureVSCode: ${errorMessage(err)}\n`);
    }
    logMcpTargetStatus("VS Code", vsStatus);
    let cursorStatus = "no_cursor";
    try {
        cursorStatus = configureCursorMcp(phrenPath, { mcpEnabled }) ?? "no_cursor";
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] link configureCursorMcp: ${errorMessage(err)}\n`);
    }
    logMcpTargetStatus("Cursor", cursorStatus);
    let copilotStatus = "no_copilot";
    try {
        copilotStatus = configureCopilotMcp(phrenPath, { mcpEnabled }) ?? "no_copilot";
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] link configureCopilotMcp: ${errorMessage(err)}\n`);
    }
    logMcpTargetStatus("Copilot CLI", copilotStatus);
    let codexStatus = "no_codex";
    try {
        codexStatus = configureCodexMcp(phrenPath, { mcpEnabled }) ?? "no_codex";
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] link configureCodexMcp: ${errorMessage(err)}\n`);
    }
    logMcpTargetStatus("Codex", codexStatus);
    const mcpStatusForContext = [mcpStatus, vsStatus, cursorStatus, copilotStatus, codexStatus].some((s) => s === "installed" || s === "already_configured")
        ? "installed"
        : [mcpStatus, vsStatus, cursorStatus, copilotStatus, codexStatus].some((s) => s === "disabled" || s === "already_disabled")
            ? "disabled"
            : mcpStatus;
    // Register hooks for Copilot CLI, Cursor, Codex
    if (hooksEnabled) {
        const hookedTools = configureAllHooks(phrenPath, { tools: detectedTools });
        if (hookedTools.length)
            log(`  Hooks registered: ${hookedTools.join(", ")}`);
    }
    else {
        log(`  Hooks registration skipped (hooks-mode is off)`);
    }
    // Write phren.SKILL.md
    try {
        writeSkillMd(phrenPath);
        log(`  phren.SKILL.md written (agentskills-compatible tools)`);
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] link writeSkillMd: ${errorMessage(err)}\n`);
    }
    log("");
    // Step 7: Context file
    if (opts.task === "debugging") {
        writeContextDebugging(machine, profile, mcpStatusForContext, projects, phrenPath);
    }
    else if (opts.task === "planning") {
        writeContextPlanning(machine, profile, mcpStatusForContext, projects, phrenPath);
    }
    else if (opts.task === "clean") {
        writeContextClean(machine, profile, mcpStatusForContext, projects);
    }
    else {
        writeContextDefault(machine, profile, mcpStatusForContext, projects, phrenPath);
    }
    // Step 8: Memory (read back native changes, then rebuild)
    readBackNativeMemory(phrenPath, projects);
    rebuildMemory(phrenPath, projects);
    log(`\nDone. Profile '${profile}' is active.`);
    if (opts.task)
        log(`Task mode: ${opts.task}`);
    log(`\nWhat's next:`);
    log(`  Start Claude in your project directory — phren injects context automatically.`);
    log(`  Run phren-discover after your first week to surface gaps in project knowledge.`);
    log(`  Run phren-consolidate after working across projects to find shared patterns.`);
}
