/**
 * Command palette and input handling for the phren interactive shell.
 * Extracted from shell.ts to keep the orchestrator under 300 lines.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { addTask, addFinding, addProjectToProfile, completeTask, listProjectCards, pinTask, readTasks, readFindings, readReviewQueue, removeFinding, removeProjectFromProfile, resetShellState, saveShellState, setMachineProfile, tidyDoneTasks, canonicalTaskFilePath, unpinTask, updateTask, workNextTask, loadShellState, resolveTaskFilePath, } from "./data-access.js";
import { runtimeFile } from "./shared.js";
import { handleGovernMemories } from "./cli-govern.js";
import { runSearch } from "./cli-search.js";
import { consolidateProjectFindings } from "./governance-policy.js";
import { style } from "./shell-render.js";
import { SUB_VIEWS, TAB_ICONS } from "./shell-types.js";
import { getProjectSkills, getHookEntries, writeInstallPreferences } from "./shell-view.js";
import { removeSkillPath, setSkillEnabledAndSync } from "./skill-files.js";
import { resultMsg, editDistance, tokenize, expandIds, normalizeSection, tasksByFilter, queueByFilter, } from "./shell-palette.js";
import { errorMessage } from "./utils.js";
function taskFileForProject(phrenPath, project) {
    return resolveTaskFilePath(phrenPath, project)
        ?? canonicalTaskFilePath(phrenPath, project)
        ?? path.join(phrenPath, project, "tasks.md");
}
export async function executePalette(host, input) {
    const trimmed = input.trim();
    if (!trimmed)
        return;
    const parts = tokenize(trimmed);
    const command = (parts[0] || "").toLowerCase();
    if (command === "help") {
        host.showHelp = true;
        host.setMessage("  Showing help — press any key to dismiss");
        return;
    }
    if (command === "projects") {
        host.setView("Projects");
        host.setMessage(`  ${TAB_ICONS.Projects} Projects`);
        return;
    }
    if (command === "tasks" || command === "task") {
        host.setView("Tasks");
        host.setMessage(`  ${TAB_ICONS.Tasks} Tasks`);
        return;
    }
    if (command === "learnings" || command === "findings" || command === "fragments") {
        host.setView("Findings");
        host.setMessage(`  ${TAB_ICONS.Findings} Fragments`);
        return;
    }
    if (command === "memory") {
        host.setView("Review Queue");
        host.setMessage(`  ${TAB_ICONS["Review Queue"]} Review Queue`);
        return;
    }
    if (command === "machines") {
        host.setView("Machines/Profiles");
        host.setMessage("  Machines/Profiles");
        return;
    }
    if (command === "health") {
        host.healthCache = undefined;
        host.setView("Health");
        host.setMessage(`  ${TAB_ICONS.Health} Health`);
        return;
    }
    if (command === "open") {
        const project = parts[1];
        if (!project) {
            host.setMessage("  Usage: :open <project>");
            return;
        }
        const cards = listProjectCards(host.phrenPath, host.profile);
        if (!cards.some((c) => c.name === project)) {
            host.setMessage(`  Unknown project: ${project}`);
            return;
        }
        host.state.project = project;
        saveShellState(host.phrenPath, host.state);
        host.setMessage(`  ${style.green("●")} ${style.boldCyan(project)} — project context set`);
        return;
    }
    if (command === "search") {
        const query = trimmed.slice("search".length).trim();
        if (!query) {
            host.setMessage("  Usage: :search <query>");
            return;
        }
        host.setMessage("  Searching…");
        try {
            const result = await runSearch({
                query,
                limit: 6,
                project: host.state.project,
            }, host.phrenPath, host.profile);
            host.setMessage(result.lines.slice(0, 14).join("\n") || "  No results.");
        }
        catch (err) {
            host.setMessage(`  Search failed: ${errorMessage(err)}`);
        }
        return;
    }
    if (command === "intro") {
        const modeRaw = (parts[1] || "").toLowerCase();
        const mode = modeRaw === "always" || modeRaw === "off" ? modeRaw : modeRaw === "once" ? "once-per-version" : modeRaw;
        if (!["always", "once-per-version", "off"].includes(mode)) {
            host.setMessage("  Usage: :intro always|once-per-version|off");
            return;
        }
        host.state.introMode = mode;
        saveShellState(host.phrenPath, host.state);
        host.setMessage(`  Intro mode: ${style.boldCyan(mode)}`);
        return;
    }
    if (command === "add") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        const text = trimmed.slice("add".length).trim();
        if (!text) {
            host.setMessage("  Usage: :add <task>");
            return;
        }
        host.setMessage(`  ${resultMsg(addTask(host.phrenPath, project, text))}`);
        return;
    }
    if (command === "complete") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        const match = parts.slice(1).join(" ").trim();
        if (!match) {
            host.setMessage("  Usage: :complete <id|match>");
            return;
        }
        const ids = expandIds(match);
        if (ids.length > 1) {
            host.confirmThen(`Complete ${ids.length} items (${ids.join(", ")})?`, () => {
                const file = taskFileForProject(host.phrenPath, project);
                host.snapshotForUndo(`complete ${ids.length} items`, file);
                host.setMessage(ids.map((id) => resultMsg(completeTask(host.phrenPath, project, id))).join("; "));
            });
        }
        else {
            host.confirmThen(`Complete "${match}"?`, () => {
                const file = taskFileForProject(host.phrenPath, project);
                host.snapshotForUndo(`complete "${match}"`, file);
                host.setMessage(`  ${resultMsg(completeTask(host.phrenPath, project, match))}`);
            });
        }
        return;
    }
    if (command === "move") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        if (parts.length < 3) {
            host.setMessage("  Usage: :move <id|match> <active|queue|done>");
            return;
        }
        const section = normalizeSection(parts[parts.length - 1]);
        if (!section) {
            host.setMessage("  Target section must be active|queue|done");
            return;
        }
        const match = parts.slice(1, -1).join(" ");
        const ids = expandIds(match);
        if (ids.length > 1) {
            const file = taskFileForProject(host.phrenPath, project);
            host.snapshotForUndo(`move ${ids.length} items to ${section}`, file);
            host.setMessage(ids.map((id) => resultMsg(updateTask(host.phrenPath, project, id, { section }))).join("; "));
        }
        else {
            host.setMessage(`  ${resultMsg(updateTask(host.phrenPath, project, match, { section }))}`);
        }
        return;
    }
    if (command === "reprioritize") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        if (parts.length < 3) {
            host.setMessage("  Usage: :reprioritize <id|match> <high|medium|low>");
            return;
        }
        const priorityRaw = parts[parts.length - 1].toLowerCase();
        if (!["high", "medium", "low"].includes(priorityRaw)) {
            host.setMessage("  Priority must be high|medium|low");
            return;
        }
        const priority = priorityRaw;
        const match = parts.slice(1, -1).join(" ");
        host.setMessage(`  ${resultMsg(updateTask(host.phrenPath, project, match, { priority }))}`);
        return;
    }
    if (command === "context") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        if (parts.length < 3) {
            host.setMessage("  Usage: :context <id|match> <text>");
            return;
        }
        const match = parts[1];
        const context = parts.slice(2).join(" ");
        host.setMessage(`  ${resultMsg(updateTask(host.phrenPath, project, match, { context }))}`);
        return;
    }
    if (command === "pin") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        if (parts.length < 2) {
            host.setMessage("  Usage: :pin <id|match>");
            return;
        }
        host.setMessage(`  ${resultMsg(pinTask(host.phrenPath, project, parts.slice(1).join(" ")))}`);
        return;
    }
    if (command === "unpin") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        if (parts.length < 2) {
            host.setMessage("  Usage: :unpin <id|match>");
            return;
        }
        host.setMessage(`  ${resultMsg(unpinTask(host.phrenPath, project, parts.slice(1).join(" ")))}`);
        return;
    }
    if (command === "work" && parts[1]?.toLowerCase() === "next") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        host.setMessage(`  ${resultMsg(workNextTask(host.phrenPath, project))}`);
        return;
    }
    if (command === "tidy") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        const keep = parts[1] ? Number.parseInt(parts[1], 10) : 30;
        const file = taskFileForProject(host.phrenPath, project);
        host.snapshotForUndo("tidy", file);
        host.setMessage(`  ${resultMsg(tidyDoneTasks(host.phrenPath, project, Number.isNaN(keep) ? 30 : keep))}`);
        return;
    }
    if (command === "learn" || command === "find") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        const action = (parts[1] || "").toLowerCase();
        if (action === "add") {
            const text = trimmed.split(/\s+/).slice(2).join(" ").trim();
            if (!text) {
                host.setMessage("  Usage: :find add <text>");
                return;
            }
            host.setMessage(`  ${resultMsg(addFinding(host.phrenPath, project, text))}`);
            return;
        }
        if (action === "remove") {
            const match = parts.slice(2).join(" ").trim();
            if (!match) {
                host.setMessage("  Usage: :find remove <id|match>");
                return;
            }
            host.confirmThen(`Remove finding "${match}"?`, () => {
                const file = path.join(host.phrenPath, project, "FINDINGS.md");
                host.snapshotForUndo(`find remove "${match}"`, file);
                host.setMessage(`  ${resultMsg(removeFinding(host.phrenPath, project, match))}`);
            });
            return;
        }
        host.setMessage("  Usage: :find add <text> | :find remove <id|match>");
        return;
    }
    if (command === "mq") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        const action = (parts[1] || "").toLowerCase();
        host.setMessage("  Queue approve/reject/edit have been removed. The review queue is now read-only.");
        return;
    }
    if (command === "machine" && parts[1]?.toLowerCase() === "map") {
        if (parts.length < 4) {
            host.setMessage("  Usage: :machine map <hostname> <profile>");
            return;
        }
        host.setMessage(`  ${resultMsg(setMachineProfile(host.phrenPath, parts[2], parts[3]))}`);
        return;
    }
    if (command === "profile") {
        const action = (parts[1] || "").toLowerCase();
        const profileName = parts[2];
        const project = parts[3];
        if (!profileName || !project) {
            host.setMessage("  Usage: :profile add-project|remove-project <profile> <project>");
            return;
        }
        if (action === "add-project") {
            host.setMessage(`  ${resultMsg(addProjectToProfile(host.phrenPath, profileName, project))}`);
            return;
        }
        if (action === "remove-project") {
            host.setMessage(`  ${resultMsg(removeProjectFromProfile(host.phrenPath, profileName, project))}`);
            return;
        }
        host.setMessage("  Usage: :profile add-project|remove-project <profile> <project>");
        return;
    }
    if ((command === "run" && parts[1]?.toLowerCase() === "fix") || command === "doctor") {
        const t0 = Date.now();
        const doctor = await host.deps.runDoctor(host.phrenPath, true);
        host.healthCache = undefined;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        host.setMessage(`  doctor --fix: ${doctor.ok ? style.green("ok") : style.red("issues remain")} (${elapsed}s)`);
        return;
    }
    if (command === "relink") {
        const t0 = Date.now();
        const r = await host.deps.runRelink(host.phrenPath);
        host.setMessage(`  ${r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        return;
    }
    if (command === "rerun" && parts[1]?.toLowerCase() === "hooks") {
        const t0 = Date.now();
        const r = await host.deps.runHooks(host.phrenPath);
        host.healthCache = undefined;
        host.setMessage(`  ${r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        return;
    }
    if (command === "update") {
        const t0 = Date.now();
        const r = await host.deps.runUpdate();
        host.setMessage(`  ${r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        return;
    }
    if (command === "govern") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        try {
            const t0 = Date.now();
            const summary = await handleGovernMemories(project, true);
            host.setMessage(`  Governed memories: stale=${summary.staleCount}, conflicts=${summary.conflictCount}, review=${summary.reviewCount}` +
                ` (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        }
        catch (err) {
            host.setMessage(`  Governance failed: ${errorMessage(err)}`);
        }
        return;
    }
    if (command === "consolidate") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        try {
            const t0 = Date.now();
            const backupPath = path.join(host.phrenPath, project, "FINDINGS.md.bak");
            const backupBefore = fs.existsSync(backupPath) ? fs.statSync(backupPath).mtimeMs : undefined;
            const result = consolidateProjectFindings(host.phrenPath, project);
            const backupAfter = fs.existsSync(backupPath) ? fs.statSync(backupPath).mtimeMs : undefined;
            const backupNote = result.ok && backupAfter !== undefined && backupAfter !== backupBefore
                ? `; Updated backup: ${path.relative(host.phrenPath, backupPath).replace(/\\/g, "/")}`
                : "";
            host.setMessage(`  ${resultMsg(result)}${backupNote} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        }
        catch (err) {
            host.setMessage(`  Consolidation failed: ${errorMessage(err)}`);
        }
        return;
    }
    if (command === "conflicts") {
        try {
            const lines = [];
            try {
                const conflicted = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
                    cwd: host.phrenPath, encoding: "utf8", timeout: 10_000,
                    stdio: ["ignore", "pipe", "ignore"],
                }).trim();
                if (conflicted) {
                    lines.push(style.boldRed("  Unresolved conflicts:"));
                    for (const f of conflicted.split("\n").filter(Boolean)) {
                        lines.push(`    ${style.red("!")} ${f}`);
                    }
                }
            }
            catch (err) {
                if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                    process.stderr.write(`[phren] shell status gitStatus: ${errorMessage(err)}\n`);
            }
            const auditPathNew = runtimeFile(host.phrenPath, "audit.log");
            const auditPathLegacy = path.join(host.phrenPath, ".governance", "audit.log");
            const auditPath = fs.existsSync(auditPathNew) ? auditPathNew : auditPathLegacy;
            if (fs.existsSync(auditPath)) {
                const auditLines = fs.readFileSync(auditPath, "utf8").split("\n")
                    .filter((l) => l.includes("auto_merge"))
                    .slice(-10);
                if (auditLines.length) {
                    lines.push(`  ${style.bold("Recent auto-merges:")}`);
                    for (const l of auditLines)
                        lines.push(`    ${style.dim(l)}`);
                }
            }
            const project = host.state.project;
            if (project) {
                const queueResult = readReviewQueue(host.phrenPath, project);
                if (queueResult.ok) {
                    const conflictItems = queueResult.data.filter((q) => q.section === "Conflicts");
                    if (conflictItems.length) {
                        lines.push(`  ${style.yellow(`${conflictItems.length} conflict(s) in Review Queue`)}  (:mq approve|reject)`);
                    }
                }
            }
            host.setMessage(lines.length ? lines.join("\n") : "  No conflicts found.");
        }
        catch (err) {
            host.setMessage(`  Conflict check failed: ${errorMessage(err)}`);
        }
        return;
    }
    if (command === "undo") {
        host.setMessage(`  ${host.popUndo()}`);
        return;
    }
    if (command === "diff") {
        const project = host.ensureProjectSelected();
        if (!project)
            return;
        try {
            const projectDir = path.join(host.phrenPath, project);
            const diff = execFileSync("git", ["diff", "--no-color", "--", projectDir], {
                cwd: host.phrenPath, encoding: "utf8", timeout: 10_000,
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            if (!diff) {
                const staged = execFileSync("git", ["diff", "--cached", "--no-color", "--", projectDir], {
                    cwd: host.phrenPath, encoding: "utf8", timeout: 10_000,
                    stdio: ["ignore", "pipe", "ignore"],
                }).trim();
                host.setMessage(staged || "  No uncommitted changes.");
            }
            else {
                const lines = diff.split("\n").slice(0, 30);
                if (diff.split("\n").length > 30)
                    lines.push(style.dim(`... (${diff.split("\n").length - 30} more lines)`));
                host.setMessage(lines.join("\n"));
            }
        }
        catch {
            host.setMessage("  Not a git repository or git not available.");
        }
        return;
    }
    if (command === "reset") {
        host.setMessage(`  ${resultMsg(resetShellState(host.phrenPath))}`);
        const newState = loadShellState(host.phrenPath);
        Object.assign(host.state, newState);
        const cards = listProjectCards(host.phrenPath, host.profile);
        host.state.project = cards[0]?.name;
        return;
    }
    const suggestion = suggestCommand(command);
    if (suggestion) {
        host.setMessage(`  Unknown: ${trimmed} — did you mean :${suggestion}?`);
    }
    else {
        host.setMessage(`  Unknown: ${trimmed} — press ${style.boldCyan("?")} for help`);
    }
}
function suggestCommand(input) {
    const known = [
        "help", "projects", "tasks", "task", "findings", "review queue", "machines", "health",
        "open", "search", "add", "complete", "move", "reprioritize", "pin", "unpin", "context",
        "work next", "tidy", "find add", "find remove", "mq approve", "mq reject",
        "mq edit", "machine map", "profile add-project", "profile remove-project",
        "run fix", "relink", "rerun hooks", "update", "govern", "consolidate",
        "undo", "diff", "conflicts", "reset",
    ];
    let best;
    let bestDist = Infinity;
    for (const cmd of known) {
        const d = editDistance(input.toLowerCase(), cmd);
        if (d < bestDist && d <= 2) {
            bestDist = d;
            best = cmd;
        }
    }
    return best;
}
export function completeInput(line, phrenPath, profile, state) {
    const commands = [
        ":projects", ":tasks", ":task", ":findings", ":review queue", ":machines", ":health",
        ":open", ":search", ":add", ":complete", ":move", ":reprioritize", ":pin",
        ":unpin", ":context", ":work next", ":tidy", ":find add", ":find remove",
        ":mq approve", ":mq reject", ":mq edit", ":machine map",
        ":profile add-project", ":profile remove-project",
        ":run fix", ":relink", ":rerun hooks", ":update", ":govern", ":consolidate",
        ":undo", ":diff", ":conflicts", ":reset", ":help",
    ];
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(":"))
        return [];
    const after = trimmed.slice(1);
    const parts = tokenize(after);
    const endsWithSpace = /\s$/.test(trimmed);
    if (parts.length === 0)
        return commands;
    if (parts.length === 1 && !endsWithSpace) {
        const prefix = `:${parts[0].toLowerCase()}`;
        return commands.filter((c) => c.startsWith(prefix));
    }
    const cmd = parts[0].toLowerCase();
    if (cmd === "open") {
        return listProjectCards(phrenPath, profile).map((c) => `:open ${c.name}`);
    }
    if (["complete", "move", "reprioritize", "context", "pin", "unpin"].includes(cmd)) {
        const project = state.project;
        if (!project)
            return [];
        const result = readTasks(phrenPath, project);
        if (!result.ok)
            return [];
        return [
            ...result.data.items.Active,
            ...result.data.items.Queue,
            ...result.data.items.Done,
        ].map((item) => `:${cmd} ${item.id}`);
    }
    if (cmd === "mq" && ["approve", "reject", "edit"].includes((parts[1] || "").toLowerCase())) {
        const project = state.project;
        if (!project)
            return [];
        const result = readReviewQueue(phrenPath, project);
        if (!result.ok)
            return [];
        return result.data.map((item) => `:mq ${parts[1].toLowerCase()} ${item.id}`);
    }
    if (cmd === "find" && (parts[1] || "").toLowerCase() === "remove") {
        const project = state.project;
        if (!project)
            return [];
        const r = readFindings(phrenPath, project);
        if (!r.ok)
            return [];
        return r.data.map((item) => `:find remove ${item.id}`);
    }
    return commands;
}
// ── List items for each view ──────────────────────────────────────────────────
export function getListItems(phrenPath, profile, state, healthLineCount) {
    switch (state.view) {
        case "Projects": {
            const cards = listProjectCards(phrenPath, profile);
            return state.filter
                ? cards.filter((c) => `${c.name} ${c.summary} ${c.docs.join(" ")}`.toLowerCase().includes(state.filter.toLowerCase()))
                : cards;
        }
        case "Tasks": {
            if (!state.project)
                return [];
            const result = readTasks(phrenPath, state.project);
            if (!result.ok)
                return [];
            const active = state.filter ? tasksByFilter(result.data.items.Active, state.filter) : result.data.items.Active;
            const queue = state.filter ? tasksByFilter(result.data.items.Queue, state.filter) : result.data.items.Queue;
            return [...active, ...queue];
        }
        case "Findings": {
            if (!state.project)
                return [];
            const result = readFindings(phrenPath, state.project);
            if (!result.ok)
                return [];
            return state.filter
                ? result.data.filter((i) => `${i.id} ${i.date} ${i.text}`.toLowerCase().includes(state.filter.toLowerCase()))
                : result.data;
        }
        case "Review Queue": {
            if (!state.project)
                return [];
            const result = readReviewQueue(phrenPath, state.project);
            if (!result.ok)
                return [];
            return state.filter ? queueByFilter(result.data, state.filter) : result.data;
        }
        case "Skills": {
            if (!state.project)
                return [];
            const allSkills = getProjectSkills(phrenPath, state.project).map((s) => ({ name: s.name, text: `${s.enabled ? "enabled" : "disabled"} · ${s.path}` }));
            return state.filter
                ? allSkills.filter((s) => `${s.name} ${s.text}`.toLowerCase().includes(state.filter.toLowerCase()))
                : allSkills;
        }
        case "Hooks": {
            return getHookEntries(phrenPath).map((e) => ({ name: e.event, text: e.enabled ? "active" : "inactive" }));
        }
        case "Health":
            return Array.from({ length: Math.max(1, healthLineCount) }, (_, i) => ({ id: String(i) }));
        default:
            return [];
    }
}
// ── Activation (Enter key) ────────────────────────────────────────────────────
async function activateSelected(host) {
    const cursor = host.currentCursor();
    const items = host.getListItems();
    const item = items[cursor];
    if (!item)
        return;
    switch (host.state.view) {
        case "Projects":
            if (item.name) {
                host.state.project = item.name;
                saveShellState(host.phrenPath, host.state);
                host.setView("Tasks");
                host.setMessage(`  ${style.green("●")} ${style.boldCyan(item.name)}`);
            }
            break;
        case "Tasks":
            if (item.id) {
                const project = host.ensureProjectSelected();
                if (!project)
                    return;
                const file = taskFileForProject(host.phrenPath, project);
                host.confirmThen(`Complete ${style.dim(item.id)} "${item.line}"?`, () => {
                    host.snapshotForUndo(`complete ${item.id}`, file);
                    const r = completeTask(host.phrenPath, project, item.id);
                    host.invalidateSubsectionsCache();
                    host.setMessage(`  ${resultMsg(r)}`);
                    host.setCursor(Math.max(0, cursor - 1));
                });
            }
            break;
        case "Findings":
            if (item.text) {
                host.setMessage(`  ${style.dim(item.id ?? "")}  ${item.text}`);
            }
            break;
        case "Review Queue":
            if (item.text) {
                host.setMessage(`  ${style.dim(item.id ?? "")}  ${item.text}  ${style.dim("[ a approve · d reject ]")}`);
            }
            break;
        case "Skills":
            if (item.name) {
                host.setMessage(`  ${style.bold(item.name)}  ${style.dim(item.text ?? "")}`);
            }
            break;
        case "Hooks":
            if (item.name) {
                host.setMessage(`  ${item.text === "active" ? style.boldGreen("active") : style.dim("inactive")}  ${style.bold(item.name)}`);
            }
            break;
    }
}
// ── View-specific action keys ─────────────────────────────────────────────────
async function doViewAction(host, key) {
    const cursor = host.currentCursor();
    const items = host.getListItems();
    const item = items[cursor];
    const project = host.state.project;
    switch (host.state.view) {
        case "Tasks":
            if (key === "a") {
                host.startInput("add", "");
            }
            else if (key === "d" && item?.id) {
                if (!project) {
                    host.setMessage("Select a project first.");
                    return;
                }
                const file = taskFileForProject(host.phrenPath, project);
                const taskResult = readTasks(host.phrenPath, project);
                const isActive = taskResult.ok && taskResult.data.items.Active.some((i) => i.id === item.id);
                const targetSection = isActive ? "Queue" : "Active";
                host.snapshotForUndo(`move ${item.id} → ${targetSection.toLowerCase()}`, file);
                const r = updateTask(host.phrenPath, project, item.id, { section: targetSection });
                host.invalidateSubsectionsCache();
                host.setMessage(`  ${resultMsg(r)}`);
            }
            break;
        case "Findings":
            if (key === "a") {
                host.startInput("learn-add", "");
            }
            else if ((key === "d" || key === "\x7f") && item?.text) {
                if (!project) {
                    host.setMessage("Select a project first.");
                    return;
                }
                host.confirmThen(`Delete finding ${style.dim(item.id ?? "")}?`, () => {
                    const file = path.join(host.phrenPath, project, "FINDINGS.md");
                    host.snapshotForUndo(`remove finding ${item.id ?? ''}`, file);
                    const r = removeFinding(host.phrenPath, project, item.text);
                    host.setMessage(`  ${resultMsg(r)}`);
                    host.setCursor(Math.max(0, cursor - 1));
                });
            }
            break;
        case "Review Queue":
            host.setMessage("  Review queue is read-only.");
            break;
        case "Skills":
            if ((key === "d" || key === "\x7f") && item?.name) {
                if (!project) {
                    host.setMessage("Select a project first.");
                    return;
                }
                const skillPath = item.text;
                host.confirmThen(`Remove skill "${item.name}"?`, () => {
                    try {
                        removeSkillPath(skillPath.split("·").slice(-1)[0].trim());
                        host.setMessage(`  Removed ${item.name}`);
                        host.setCursor(Math.max(0, cursor - 1));
                    }
                    catch (err) {
                        host.setMessage(`  Failed: ${errorMessage(err)}`);
                    }
                });
            }
            else if (key === "t" && item?.name) {
                if (!project) {
                    host.setMessage("Select a project first.");
                    return;
                }
                const isEnabled = !item.text?.startsWith("disabled");
                setSkillEnabledAndSync(host.phrenPath, project, item.name, !isEnabled);
                host.setMessage(`  ${!isEnabled ? "Enabled" : "Disabled"} ${item.name}`);
            }
            else if (key === "a") {
                if (!project) {
                    host.setMessage("Select a project first.");
                    return;
                }
                host.startInput("skill-add", "");
            }
            break;
        case "Hooks":
            if (key === "a" || key === "d") {
                const enable = key === "a";
                writeInstallPreferences(host.phrenPath, { hooksEnabled: enable });
                host.setMessage(`  Hooks ${enable ? style.boldGreen("enabled") : style.dim("disabled")} — takes effect next session`);
            }
            break;
    }
}
// ── Cursor position display ───────────────────────────────────────────────────
function showCursorPosition(host) {
    const items = host.getListItems();
    const count = items.length;
    if (count === 0)
        return;
    const cursor = host.currentCursor();
    const item = items[cursor];
    const label = item?.name ?? item?.line ?? item?.text ?? "";
    const short = label.length > 50 ? label.slice(0, 48) + "…" : label;
    host.setMessage(`  ${style.dim(`${cursor + 1} / ${count}`)}${short ? `  ${style.dimItalic(short)}` : ""}`);
}
// ── Navigate-mode key handler ─────────────────────────────────────────────────
export async function handleNavigateKey(host, key) {
    if (key === "\x1b[A") {
        host.moveCursor(-1);
        showCursorPosition(host);
        return true;
    }
    if (key === "\x1b[B") {
        host.moveCursor(1);
        showCursorPosition(host);
        return true;
    }
    if (key === "\x1b[D") {
        if (host.state.view === "Projects") {
            host.setMessage(`  ${style.dim("Projects is the dashboard landing screen")}`);
        }
        else {
            prevTab(host);
        }
        return true;
    }
    if (key === "\x1b[C") {
        if (host.state.view === "Projects") {
            host.setMessage(`  ${style.dim("Press ↵ to enter the selected project's tasks")}`);
        }
        else {
            nextTab(host);
        }
        return true;
    }
    if (key === "\x1b[5~") {
        host.moveCursor(-10);
        showCursorPosition(host);
        return true;
    }
    if (key === "\x1b[6~") {
        host.moveCursor(10);
        showCursorPosition(host);
        return true;
    }
    if (key === "\x1b[H" || key === "\x1b[1~") {
        host.setCursor(0);
        showCursorPosition(host);
        return true;
    }
    if (key === "\x1b[F" || key === "\x1b[4~") {
        host.setCursor(host.getListItems().length - 1);
        showCursorPosition(host);
        return true;
    }
    if (key === "\t") {
        nextTab(host);
        return true;
    }
    if (key === "\x1b[Z") {
        prevTab(host);
        return true;
    }
    if (key === "q" || key === "Q")
        return false;
    if (key === "\r" || key === "\n") {
        await activateSelected(host);
        return true;
    }
    if (key === "?") {
        host.showHelp = !host.showHelp;
        host.setMessage(host.showHelp ? "  Showing help — press any key to dismiss" : `  ${style.boldCyan("←→")} ${style.dim("tabs")}  ${style.boldCyan("↑↓")} ${style.dim("move")}  ${style.boldCyan("↵")} ${style.dim("activate")}  ${style.boldCyan("?")} ${style.dim("help")}`);
        return true;
    }
    if (key === "/") {
        host.startInput("filter", host.filter || "");
        return true;
    }
    if (key === ":") {
        host.startInput("command", "");
        return true;
    }
    if (key === "\x1b") {
        if (host.filter) {
            host.setFilter("");
        }
        else if (host.state.view === "Health") {
            const returnTo = host.prevHealthView ?? "Projects";
            host.setView(returnTo);
            host.prevHealthView = undefined;
            host.setMessage(`  ${TAB_ICONS[returnTo] ?? TAB_ICONS.Projects} ${returnTo}`);
        }
        else if (host.state.view !== "Projects") {
            host.setView("Projects");
            host.setMessage(`  ${TAB_ICONS.Projects} ${style.dim("dashboard")}`);
        }
        else {
            host.setMessage(`  ${style.dim("press")} ${style.boldCyan("q")} ${style.dim("to quit")}`);
        }
        return true;
    }
    if (key === "p") {
        host.setView("Projects");
        host.setMessage(`  ${TAB_ICONS.Projects} Projects`);
        return true;
    }
    if (key === "b") {
        if (!host.state.project) {
            host.setMessage(style.dim("  Select a project first (↵)"));
            return true;
        }
        host.setView("Tasks");
        host.setMessage(`  ${TAB_ICONS.Tasks} Tasks`);
        return true;
    }
    if (key === "l") {
        if (!host.state.project) {
            host.setMessage(style.dim("  Select a project first (↵)"));
            return true;
        }
        host.setView("Findings");
        host.setMessage(`  ${TAB_ICONS.Findings} Fragments`);
        return true;
    }
    if (key === "m") {
        if (!host.state.project) {
            host.setMessage(style.dim("  Select a project first (↵)"));
            return true;
        }
        host.setView("Review Queue");
        host.setMessage(`  ${TAB_ICONS["Review Queue"]} Review Queue`);
        return true;
    }
    if (key === "s") {
        if (!host.state.project) {
            host.setMessage(style.dim("  Select a project first (↵)"));
            return true;
        }
        host.setView("Skills");
        host.setMessage(`  ${TAB_ICONS.Skills} Skills`);
        return true;
    }
    if (key === "k") {
        host.setView("Hooks");
        host.setMessage(`  ${TAB_ICONS.Hooks} Hooks`);
        return true;
    }
    if (key === "h") {
        host.prevHealthView = host.state.view === "Health" ? host.prevHealthView : host.state.view;
        host.healthCache = undefined;
        host.setView("Health");
        host.setMessage(`  ${TAB_ICONS.Health} Health  ${style.dim("(esc to return)")}`);
        return true;
    }
    if (key === "i" && host.state.view === "Projects") {
        const next = host.state.introMode === "always" ? "once-per-version" : host.state.introMode === "off" ? "always" : "off";
        host.state.introMode = next;
        saveShellState(host.phrenPath, host.state);
        host.setMessage(`  Intro mode: ${style.boldCyan(next)}`);
        return true;
    }
    if (["a", "d", "e", "t", "\x7f"].includes(key)) {
        await doViewAction(host, key);
        return true;
    }
    return true;
}
// ── Tab switching ─────────────────────────────────────────────────────────────
function nextTab(host) {
    if (host.state.view === "Projects" || host.state.view === "Health")
        return;
    const idx = SUB_VIEWS.indexOf(host.state.view);
    const next = SUB_VIEWS[(idx + 1) % SUB_VIEWS.length];
    if (next) {
        host.setView(next);
        host.setMessage(`  ${TAB_ICONS[next]} ${next}`);
    }
}
function prevTab(host) {
    if (host.state.view === "Projects" || host.state.view === "Health")
        return;
    const idx = SUB_VIEWS.indexOf(host.state.view);
    const prev = SUB_VIEWS[(idx - 1 + SUB_VIEWS.length) % SUB_VIEWS.length];
    if (prev) {
        host.setView(prev);
        host.setMessage(`  ${TAB_ICONS[prev]} ${prev}`);
    }
}
