"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const cortexClient_1 = require("./cortexClient");
const CortexTreeProvider_1 = require("./providers/CortexTreeProvider");
const searchQuickPick_1 = require("./searchQuickPick");
const statusBar_1 = require("./statusBar");
const graphWebview_1 = require("./graphWebview");
const findingViewer_1 = require("./findingViewer");
const projectFileViewer_1 = require("./projectFileViewer");
const skillEditor_1 = require("./skillEditor");
const taskViewer_1 = require("./taskViewer");
const queueViewer_1 = require("./queueViewer");
const runtimeConfig_1 = require("./runtimeConfig");
let client;
let outputChannel;
async function activate(context) {
    outputChannel = vscode.window.createOutputChannel("Cortex");
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine("Cortex extension activating...");
    const config = vscode.workspace.getConfiguration("cortex");
    const runtimeConfig = (0, runtimeConfig_1.resolveRuntimeConfig)(config);
    outputChannel.appendLine(`Cortex store path: ${runtimeConfig.storePath}`);
    outputChannel.appendLine(`Node path: ${runtimeConfig.nodePath}`);
    outputChannel.appendLine(`MCP server path: ${runtimeConfig.mcpServerPath ?? "(not found; configure cortex.mcpServerPath or install Cortex globally)"}`);
    if (!runtimeConfig.mcpServerPath) {
        const choice = await vscode.window.showErrorMessage("Cortex MCP server entrypoint could not be auto-detected. Set cortex.mcpServerPath or install Cortex globally.", "Open Settings");
        if (choice === "Open Settings") {
            await vscode.commands.executeCommand("workbench.action.openSettings", "cortex.mcpServerPath");
        }
        return;
    }
    if (!(0, runtimeConfig_1.pathExists)(runtimeConfig.mcpServerPath)) {
        const basename = path.basename(runtimeConfig.mcpServerPath);
        const choice = await vscode.window.showErrorMessage(`Configured Cortex MCP server entrypoint does not exist: ${basename}`, "Open Settings");
        if (choice === "Open Settings") {
            await vscode.commands.executeCommand("workbench.action.openSettings", "cortex.mcpServerPath");
        }
        return;
    }
    const cortexClient = new cortexClient_1.CortexClient({
        mcpServerPath: runtimeConfig.mcpServerPath,
        storePath: runtimeConfig.storePath,
        nodePath: runtimeConfig.nodePath,
        clientVersion: context.extension.packageJSON.version,
    });
    client = cortexClient;
    const treeDataProvider = new CortexTreeProvider_1.CortexTreeProvider(cortexClient);
    const treeView = vscode.window.createTreeView("cortex.explorer", {
        treeDataProvider,
    });
    const statusBar = new statusBar_1.CortexStatusBar(cortexClient);
    statusBar.setOnHealthChanged((ok) => treeDataProvider.setHealthStatus(ok));
    context.subscriptions.push(treeDataProvider, treeView, statusBar);
    const setActiveProjectDisposable = vscode.commands.registerCommand("cortex.setActiveProject", async () => {
        try {
            await statusBar.promptForActiveProject();
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to load Cortex projects: ${toErrorMessage(error)}`);
        }
    });
    const addFindingDisposable = vscode.commands.registerCommand("cortex.addFinding", async () => {
        const activeProject = statusBar.getActiveProjectName();
        if (!activeProject) {
            await vscode.window.showWarningMessage("No active Cortex project selected.");
            return;
        }
        const findingText = await vscode.window.showInputBox({ prompt: "Enter finding text" });
        const trimmedFindingText = findingText?.trim();
        if (!trimmedFindingText) {
            return;
        }
        try {
            await cortexClient.addFinding(activeProject, trimmedFindingText);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Finding added to ${activeProject}`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to add finding: ${toErrorMessage(error)}`);
        }
    });
    const searchDisposable = vscode.commands.registerCommand("cortex.search", async () => {
        try {
            await (0, searchQuickPick_1.showSearchQuickPick)(cortexClient);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to search Cortex knowledge: ${toErrorMessage(error)}`);
        }
    });
    const showGraphDisposable = vscode.commands.registerCommand("cortex.showGraph", async () => {
        try {
            await (0, graphWebview_1.showGraphWebview)(cortexClient, context);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to show Cortex graph: ${toErrorMessage(error)}`);
        }
    });
    const refreshDisposable = vscode.commands.registerCommand("cortex.refresh", async () => {
        treeDataProvider.refresh();
        try {
            await statusBar.initialize();
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to refresh Cortex extension state: ${toErrorMessage(error)}`);
        }
    });
    const refreshTree = () => treeDataProvider.refresh();
    const openFindingDisposable = vscode.commands.registerCommand("cortex.openFinding", (finding) => {
        (0, findingViewer_1.showFindingDetail)(cortexClient, finding, refreshTree);
    });
    const openProjectFileDisposable = vscode.commands.registerCommand("cortex.openProjectFile", async (projectName, fileName) => {
        try {
            await (0, projectFileViewer_1.showProjectFile)(cortexClient, projectName, fileName);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to open project file: ${toErrorMessage(error)}`);
        }
    });
    const openSkillDisposable = vscode.commands.registerCommand("cortex.openSkill", async (skillName, skillSource) => {
        try {
            await (0, skillEditor_1.showSkillEditor)(cortexClient, skillName, skillSource);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to open skill: ${toErrorMessage(error)}`);
        }
    });
    const toggleSkillDisposable = vscode.commands.registerCommand("cortex.toggleSkill", async (skillName, skillSource, currentlyEnabled) => {
        try {
            const project = skillSource === "global" ? undefined : skillSource;
            if (currentlyEnabled) {
                await cortexClient.disableSkill(skillName, project);
            }
            else {
                await cortexClient.enableSkill(skillName, project);
            }
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Skill "${skillName}" ${currentlyEnabled ? "disabled" : "enabled"}.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to toggle skill: ${toErrorMessage(error)}`);
        }
    });
    const toggleHookDisposable = vscode.commands.registerCommand("cortex.toggleHook", async (toolOrNode, currentlyEnabled) => {
        try {
            const tool = typeof toolOrNode === "string" ? toolOrNode : toolOrNode.tool;
            const enabled = typeof toolOrNode === "string" ? currentlyEnabled : toolOrNode.enabled;
            await cortexClient.toggleHooks(!enabled, tool);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Hooks for "${tool}" ${enabled ? "disabled" : "enabled"}.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to toggle hook: ${toErrorMessage(error)}`);
        }
    });
    const openTaskDisposable = vscode.commands.registerCommand("cortex.openTask", (task) => {
        (0, taskViewer_1.showTaskDetail)(cortexClient, task, refreshTree);
    });
    const openQueueItemDisposable = vscode.commands.registerCommand("cortex.openQueueItem", (item) => {
        (0, queueViewer_1.showQueueItemDetail)(cortexClient, item, refreshTree);
    });
    // --- Add Task command ---
    const addTaskDisposable = vscode.commands.registerCommand("cortex.addTask", async () => {
        let project = statusBar.getActiveProjectName();
        if (!project) {
            const projectsRaw = await cortexClient.listProjects();
            const projectsData = asRecord(asRecord(projectsRaw)?.data);
            const projects = asArraySafe(projectsData?.projects);
            const projectNames = [];
            for (const p of projects) {
                const rec = asRecord(p);
                const name = typeof rec?.name === "string" ? rec.name : undefined;
                if (name)
                    projectNames.push(name);
            }
            if (projectNames.length === 0) {
                await vscode.window.showWarningMessage("No Cortex projects found.");
                return;
            }
            project = await vscode.window.showQuickPick(projectNames, { placeHolder: "Select a project" });
            if (!project)
                return;
        }
        const taskText = await vscode.window.showInputBox({ prompt: "Enter task text" });
        const trimmedTaskText = taskText?.trim();
        if (!trimmedTaskText)
            return;
        try {
            await cortexClient.addTask(project, trimmedTaskText);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Task added to ${project}`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to add task: ${toErrorMessage(error)}`);
        }
    });
    // --- Complete Task command (from tree view context menu) ---
    const completeTaskDisposable = vscode.commands.registerCommand("cortex.completeTask", async (task) => {
        try {
            await cortexClient.completeTask(task.projectName, task.line);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Task "${task.id}" marked complete.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to complete task: ${toErrorMessage(error)}`);
        }
    });
    // --- Remove Finding command ---
    const removeFindingDisposable = vscode.commands.registerCommand("cortex.removeFinding", async (finding) => {
        if (finding) {
            // Called from tree view context menu
            const confirmed = await vscode.window.showWarningMessage(`Remove finding "${finding.id}"?`, { modal: true }, "Remove");
            if (confirmed !== "Remove")
                return;
            try {
                await cortexClient.removeFinding(finding.projectName, finding.text);
                treeDataProvider.refresh();
                await vscode.window.showInformationMessage(`Finding "${finding.id}" removed.`);
            }
            catch (error) {
                await vscode.window.showErrorMessage(`Failed to remove finding: ${toErrorMessage(error)}`);
            }
        }
        else {
            // Called from command palette — prompt for project and text
            const activeProject = statusBar.getActiveProjectName();
            let project = activeProject;
            if (!project) {
                const projectsRaw = await cortexClient.listProjects();
                const projectsData = asRecord(asRecord(projectsRaw)?.data);
                const projects = asArraySafe(projectsData?.projects);
                const projectNames = [];
                for (const p of projects) {
                    const rec = asRecord(p);
                    const name = typeof rec?.name === "string" ? rec.name : undefined;
                    if (name)
                        projectNames.push(name);
                }
                project = await vscode.window.showQuickPick(projectNames, { placeHolder: "Select a project" });
                if (!project)
                    return;
            }
            const findingText = await vscode.window.showInputBox({ prompt: "Enter exact finding text to remove" });
            if (!findingText?.trim())
                return;
            try {
                await cortexClient.removeFinding(project, findingText.trim());
                treeDataProvider.refresh();
                await vscode.window.showInformationMessage("Finding removed.");
            }
            catch (error) {
                await vscode.window.showErrorMessage(`Failed to remove finding: ${toErrorMessage(error)}`);
            }
        }
    });
    // --- Pin Memory command ---
    const pinMemoryDisposable = vscode.commands.registerCommand("cortex.pinMemory", async () => {
        let project = statusBar.getActiveProjectName();
        if (!project) {
            const projectsRaw = await cortexClient.listProjects();
            const projectsData = asRecord(asRecord(projectsRaw)?.data);
            const projects = asArraySafe(projectsData?.projects);
            const projectNames = [];
            for (const p of projects) {
                const rec = asRecord(p);
                const name = typeof rec?.name === "string" ? rec.name : undefined;
                if (name)
                    projectNames.push(name);
            }
            if (projectNames.length === 0) {
                await vscode.window.showWarningMessage("No Cortex projects found.");
                return;
            }
            project = await vscode.window.showQuickPick(projectNames, { placeHolder: "Select a project" });
            if (!project)
                return;
        }
        const memoryText = await vscode.window.showInputBox({ prompt: "Enter memory text to pin" });
        const trimmedMemoryText = memoryText?.trim();
        if (!trimmedMemoryText)
            return;
        try {
            await cortexClient.pinMemory(project, trimmedMemoryText);
            await vscode.window.showInformationMessage(`Memory pinned to ${project}`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to pin memory: ${toErrorMessage(error)}`);
        }
    });
    const syncDisposable = vscode.commands.registerCommand("cortex.sync", async () => {
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Cortex: Syncing...", cancellable: false }, async () => {
                await cortexClient.pushChanges();
            });
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage("Cortex: Sync complete.");
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Cortex sync failed: ${toErrorMessage(error)}`);
        }
    });
    // --- Doctor command ---
    const doctorDisposable = vscode.commands.registerCommand("cortex.doctor", async () => {
        try {
            const raw = await cortexClient.healthCheck();
            const data = asRecord(asRecord(raw)?.data);
            outputChannel.clear();
            outputChannel.appendLine("=== Cortex Doctor ===");
            outputChannel.appendLine("");
            if (data) {
                if (data.version)
                    outputChannel.appendLine(`Version: ${data.version}`);
                if (data.profile)
                    outputChannel.appendLine(`Profile: ${data.profile}`);
                if (data.machine)
                    outputChannel.appendLine(`Machine: ${data.machine}`);
                if (data.projectCount !== undefined)
                    outputChannel.appendLine(`Projects: ${data.projectCount}`);
                if (data.storePath)
                    outputChannel.appendLine(`Store: ${data.storePath}`);
                const index = asRecord(data.index);
                if (index) {
                    outputChannel.appendLine("");
                    outputChannel.appendLine("FTS Index:");
                    if (index.docCount !== undefined)
                        outputChannel.appendLine(`  Documents: ${index.docCount}`);
                    if (index.entityCount !== undefined)
                        outputChannel.appendLine(`  Entities: ${index.entityCount}`);
                    if (index.stale !== undefined)
                        outputChannel.appendLine(`  Stale: ${index.stale}`);
                }
                const hooks = asRecord(data.hooks);
                if (hooks) {
                    outputChannel.appendLine("");
                    outputChannel.appendLine("Hooks:");
                    if (hooks.globalEnabled !== undefined)
                        outputChannel.appendLine(`  Global: ${hooks.globalEnabled ? "enabled" : "disabled"}`);
                    const tools = asArraySafe(hooks.tools);
                    for (const t of tools) {
                        const rec = asRecord(t);
                        if (rec?.tool)
                            outputChannel.appendLine(`  ${rec.tool}: ${rec.enabled ? "enabled" : "disabled"}`);
                    }
                }
                // Print any remaining top-level keys as-is
                for (const key of Object.keys(data)) {
                    if (["version", "profile", "machine", "projectCount", "storePath", "index", "hooks"].includes(key))
                        continue;
                    outputChannel.appendLine(`${key}: ${JSON.stringify(data[key])}`);
                }
            }
            else {
                outputChannel.appendLine(JSON.stringify(raw, null, 2));
            }
            outputChannel.appendLine("");
            outputChannel.appendLine("=== End ===");
            outputChannel.show(true);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Cortex doctor failed: ${toErrorMessage(error)}`);
        }
    });
    // --- Hooks Status command ---
    const hooksStatusDisposable = vscode.commands.registerCommand("cortex.hooksStatus", async () => {
        try {
            const raw = await cortexClient.listHooks();
            const data = asRecord(asRecord(raw)?.data);
            outputChannel.clear();
            outputChannel.appendLine("=== Cortex Hooks Status ===");
            outputChannel.appendLine("");
            if (data) {
                if (data.globalEnabled !== undefined) {
                    outputChannel.appendLine(`Global: ${data.globalEnabled ? "enabled" : "disabled"}`);
                }
                outputChannel.appendLine("");
                const tools = asArraySafe(data.tools);
                for (const t of tools) {
                    const rec = asRecord(t);
                    if (!rec?.tool)
                        continue;
                    const status = rec.enabled ? "enabled" : "disabled";
                    const exists = rec.exists ? "" : " (config not found)";
                    outputChannel.appendLine(`  ${rec.tool}: ${status}${exists}`);
                    if (rec.configPath)
                        outputChannel.appendLine(`    Path: ${rec.configPath}`);
                }
                const customHooks = asArraySafe(data.customHooks);
                if (customHooks.length > 0) {
                    outputChannel.appendLine("");
                    outputChannel.appendLine("Custom Hooks:");
                    for (const h of customHooks) {
                        const rec = asRecord(h);
                        if (rec)
                            outputChannel.appendLine(`  ${rec.event}: ${rec.command}`);
                    }
                }
            }
            else {
                outputChannel.appendLine(JSON.stringify(raw, null, 2));
            }
            outputChannel.appendLine("");
            outputChannel.appendLine("=== End ===");
            outputChannel.show(true);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to get hooks status: ${toErrorMessage(error)}`);
        }
    });
    // --- Toggle Hooks command ---
    const toggleHooksCommandDisposable = vscode.commands.registerCommand("cortex.toggleHooksCommand", async () => {
        try {
            const raw = await cortexClient.listHooks();
            const data = asRecord(asRecord(raw)?.data);
            const tools = asArraySafe(data?.tools);
            const picks = [];
            for (const t of tools) {
                const rec = asRecord(t);
                if (!rec?.tool)
                    continue;
                const toolName = String(rec.tool);
                const enabled = rec.enabled === true;
                picks.push({
                    label: toolName,
                    description: enabled ? "enabled" : "disabled",
                    detail: `Click to ${enabled ? "disable" : "enable"} hooks for ${toolName}`,
                });
            }
            if (picks.length === 0) {
                await vscode.window.showInformationMessage("No hook tools configured.");
                return;
            }
            const choice = await vscode.window.showQuickPick(picks, { placeHolder: "Select a tool to toggle hooks" });
            if (!choice)
                return;
            const currentlyEnabled = choice.description === "enabled";
            await cortexClient.toggleHooks(!currentlyEnabled, choice.label);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Hooks for "${choice.label}" ${currentlyEnabled ? "disabled" : "enabled"}.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to toggle hooks: ${toErrorMessage(error)}`);
        }
    });
    // --- Manage Project command ---
    const manageProjectDisposable = vscode.commands.registerCommand("cortex.manageProject", async () => {
        try {
            const projectsRaw = await cortexClient.listProjects();
            const projectsData = asRecord(asRecord(projectsRaw)?.data);
            const projects = asArraySafe(projectsData?.projects);
            const projectNames = [];
            for (const p of projects) {
                const rec = asRecord(p);
                const name = typeof rec?.name === "string" ? rec.name : undefined;
                if (name)
                    projectNames.push(name);
            }
            if (projectNames.length === 0) {
                await vscode.window.showInformationMessage("No projects found.");
                return;
            }
            const projectChoice = await vscode.window.showQuickPick(projectNames, { placeHolder: "Select a project to manage" });
            if (!projectChoice)
                return;
            const actionChoice = await vscode.window.showQuickPick([
                { label: "Archive", description: "Archive this project" },
                { label: "Unarchive", description: "Restore this project" },
            ], { placeHolder: `Action for "${projectChoice}"` });
            if (!actionChoice)
                return;
            const action = actionChoice.label.toLowerCase();
            await cortexClient.manageProject(projectChoice, action);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Project "${projectChoice}" ${action}d.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to manage project: ${toErrorMessage(error)}`);
        }
    });
    // --- Switch Profile command ---
    const switchProfileDisposable = vscode.commands.registerCommand("cortex.switchProfile", async () => {
        try {
            const profilesDir = path.join(os.homedir(), ".cortex", "profiles");
            let profileNames = [];
            if (fs.existsSync(profilesDir)) {
                const entries = fs.readdirSync(profilesDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
                profileNames = entries.map((f) => f.replace(/\.ya?ml$/, ""));
            }
            if (profileNames.length === 0) {
                await vscode.window.showInformationMessage("No profiles found in ~/.cortex/profiles/");
                return;
            }
            const choice = await vscode.window.showQuickPick(profileNames, { placeHolder: "Select a profile to activate" });
            if (!choice)
                return;
            // Write the chosen profile to cortex-context.md
            const contextPath = path.join(os.homedir(), ".cortex-context.md");
            let content = "";
            if (fs.existsSync(contextPath)) {
                content = fs.readFileSync(contextPath, "utf8");
            }
            if (/^Profile:\s*.+/m.test(content)) {
                content = content.replace(/^Profile:\s*.+/m, `Profile: ${choice}`);
            }
            else {
                content = `Profile: ${choice}\n${content}`;
            }
            fs.writeFileSync(contextPath, content, "utf8");
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Profile switched to "${choice}".`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to switch profile: ${toErrorMessage(error)}`);
        }
    });
    const filterFindingsByDateDisposable = vscode.commands.registerCommand("cortex.filterFindingsByDate", async () => {
        const current = treeDataProvider.getDateFilter();
        const picks = [
            { label: "Today", description: "Show only today's findings" },
            { label: "Last 7 days", description: "Show findings from the past week" },
            { label: "Last 30 days", description: "Show findings from the past month" },
            { label: "Custom range...", description: "Pick a start and end date" },
            { label: "Clear filter", description: current ? `Currently: ${current.label}` : "No filter active" },
        ];
        const choice = await vscode.window.showQuickPick(picks, { placeHolder: "Filter findings by date" });
        if (!choice)
            return;
        if (choice.label === "Clear filter") {
            treeDataProvider.setDateFilter(undefined);
            return;
        }
        const today = new Date();
        const fmt = (d) => d.toISOString().slice(0, 10);
        if (choice.label === "Today") {
            const todayStr = fmt(today);
            treeDataProvider.setDateFilter({ from: todayStr, to: todayStr, label: "Today" });
        }
        else if (choice.label === "Last 7 days") {
            const from = new Date(today);
            from.setDate(from.getDate() - 7);
            treeDataProvider.setDateFilter({ from: fmt(from), to: fmt(today), label: "Last 7 days" });
        }
        else if (choice.label === "Last 30 days") {
            const from = new Date(today);
            from.setDate(from.getDate() - 30);
            treeDataProvider.setDateFilter({ from: fmt(from), to: fmt(today), label: "Last 30 days" });
        }
        else if (choice.label === "Custom range...") {
            const fromStr = await vscode.window.showInputBox({
                prompt: "Start date (YYYY-MM-DD)",
                placeHolder: "2026-01-01",
                validateInput: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : "Use YYYY-MM-DD format",
            });
            if (!fromStr)
                return;
            const toStr = await vscode.window.showInputBox({
                prompt: "End date (YYYY-MM-DD)",
                placeHolder: fmt(today),
                value: fmt(today),
                validateInput: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : "Use YYYY-MM-DD format",
            });
            if (!toStr)
                return;
            treeDataProvider.setDateFilter({ from: fromStr, to: toStr, label: `${fromStr} to ${toStr}` });
        }
    });
    context.subscriptions.push(setActiveProjectDisposable, addFindingDisposable, searchDisposable, showGraphDisposable, refreshDisposable, openFindingDisposable, openProjectFileDisposable, openSkillDisposable, toggleSkillDisposable, toggleHookDisposable, openTaskDisposable, openQueueItemDisposable, filterFindingsByDateDisposable, switchProfileDisposable, syncDisposable, doctorDisposable, hooksStatusDisposable, toggleHooksCommandDisposable, manageProjectDisposable, addTaskDisposable, completeTaskDisposable, removeFindingDisposable, pinMemoryDisposable);
    try {
        await statusBar.initialize();
        outputChannel.appendLine("Status bar initialized successfully");
    }
    catch (error) {
        outputChannel.appendLine(`Status bar init failed: ${toErrorMessage(error)}`);
        await vscode.window.showErrorMessage(`Failed to initialize active Cortex project: ${toErrorMessage(error)}`);
    }
}
async function deactivate() {
    if (!client) {
        return;
    }
    await client.dispose();
    client = undefined;
}
function toErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : undefined;
}
function asArraySafe(value) {
    return Array.isArray(value) ? value : [];
}
//# sourceMappingURL=extension.js.map