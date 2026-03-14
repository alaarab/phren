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
const child_process_1 = require("child_process");
const phrenClient_1 = require("./phrenClient");
const PhrenTreeProvider_1 = require("./providers/PhrenTreeProvider");
const searchQuickPick_1 = require("./searchQuickPick");
const statusBar_1 = require("./statusBar");
const graphWebview_1 = require("./graphWebview");
const findingViewer_1 = require("./findingViewer");
const projectFileViewer_1 = require("./projectFileViewer");
const skillEditor_1 = require("./skillEditor");
const taskViewer_1 = require("./taskViewer");
const queueViewer_1 = require("./queueViewer");
const sessionViewer_1 = require("./sessionViewer");
const runtimeConfig_1 = require("./runtimeConfig");
const profileConfig_1 = require("./profileConfig");
let client;
let outputChannel;
const GLOBAL_PHREN_STORE_PATH = path.join(os.homedir(), ".phren");
const PHREN_PACKAGE_NAME = "@alaarab/phren";
const ONBOARDING_COMPLETE_SETTING = "onboardingComplete";
async function activate(context) {
    outputChannel = vscode.window.createOutputChannel("Phren");
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine("Phren extension activating...");
    const config = vscode.workspace.getConfiguration("phren");
    await runOnboardingIfNeeded(config);
    const runtimeConfig = (0, runtimeConfig_1.resolveRuntimeConfig)(vscode.workspace.getConfiguration("phren"));
    outputChannel.appendLine(`Phren store path: ${runtimeConfig.storePath}`);
    outputChannel.appendLine(`Node path: ${runtimeConfig.nodePath}`);
    outputChannel.appendLine(`MCP server path: ${runtimeConfig.mcpServerPath ?? "(not found; configure phren.mcpServerPath or install Phren globally)"}`);
    if (!runtimeConfig.mcpServerPath) {
        const choice = await vscode.window.showErrorMessage("Phren MCP server entrypoint could not be auto-detected. Set phren.mcpServerPath or install Phren globally.", "Open Settings");
        if (choice === "Open Settings") {
            await vscode.commands.executeCommand("workbench.action.openSettings", "phren.mcpServerPath");
        }
        return;
    }
    if (!(0, runtimeConfig_1.pathExists)(runtimeConfig.mcpServerPath)) {
        const basename = path.basename(runtimeConfig.mcpServerPath);
        const choice = await vscode.window.showErrorMessage(`Configured Phren MCP server entrypoint does not exist: ${basename}`, "Open Settings");
        if (choice === "Open Settings") {
            await vscode.commands.executeCommand("workbench.action.openSettings", "phren.mcpServerPath");
        }
        return;
    }
    const phrenClient = new phrenClient_1.PhrenClient({
        mcpServerPath: runtimeConfig.mcpServerPath,
        storePath: runtimeConfig.storePath,
        nodePath: runtimeConfig.nodePath,
        clientVersion: context.extension.packageJSON.version,
    });
    client = phrenClient;
    const treeDataProvider = new PhrenTreeProvider_1.PhrenTreeProvider(phrenClient, runtimeConfig.storePath);
    const treeView = vscode.window.createTreeView("phren.explorer", {
        treeDataProvider,
    });
    const statusBar = new statusBar_1.PhrenStatusBar(phrenClient);
    statusBar.setOnHealthChanged((ok) => treeDataProvider.setHealthStatus(ok));
    context.subscriptions.push(treeDataProvider, treeView, statusBar);
    const setActiveProjectDisposable = vscode.commands.registerCommand("phren.setActiveProject", async () => {
        try {
            await statusBar.promptForActiveProject();
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to load Phren projects: ${toErrorMessage(error)}`);
        }
    });
    const addFindingDisposable = vscode.commands.registerCommand("phren.addFinding", async () => {
        const activeProject = statusBar.getActiveProjectName();
        if (!activeProject) {
            await vscode.window.showWarningMessage("No active Phren project selected.");
            return;
        }
        const findingText = await vscode.window.showInputBox({ prompt: "Enter finding text" });
        const trimmedFindingText = findingText?.trim();
        if (!trimmedFindingText) {
            return;
        }
        try {
            await phrenClient.addFinding(activeProject, trimmedFindingText);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Finding added to ${activeProject}`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to add finding: ${toErrorMessage(error)}`);
        }
    });
    const searchDisposable = vscode.commands.registerCommand("phren.search", async () => {
        try {
            await (0, searchQuickPick_1.showSearchQuickPick)(phrenClient);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to search Phren knowledge: ${toErrorMessage(error)}`);
        }
    });
    const showGraphDisposable = vscode.commands.registerCommand("phren.showGraph", async () => {
        try {
            await (0, graphWebview_1.showGraphWebview)(phrenClient, context);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to show Phren graph: ${toErrorMessage(error)}`);
        }
    });
    const refreshDisposable = vscode.commands.registerCommand("phren.refresh", async () => {
        treeDataProvider.refresh();
        try {
            await statusBar.initialize();
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to refresh Phren extension state: ${toErrorMessage(error)}`);
        }
    });
    const refreshTree = () => treeDataProvider.refresh();
    const openFindingDisposable = vscode.commands.registerCommand("phren.openFinding", (finding) => {
        (0, findingViewer_1.showFindingDetail)(phrenClient, finding, refreshTree);
    });
    const openProjectFileDisposable = vscode.commands.registerCommand("phren.openProjectFile", async (projectName, fileName) => {
        try {
            await (0, projectFileViewer_1.showProjectFile)(phrenClient, projectName, fileName);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to open project file: ${toErrorMessage(error)}`);
        }
    });
    const openSkillDisposable = vscode.commands.registerCommand("phren.openSkill", async (skillName, skillSource) => {
        try {
            await (0, skillEditor_1.showSkillEditor)(phrenClient, skillName, skillSource);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to open skill: ${toErrorMessage(error)}`);
        }
    });
    const toggleSkillDisposable = vscode.commands.registerCommand("phren.toggleSkill", async (skillName, skillSource, currentlyEnabled) => {
        try {
            const project = skillSource === "global" ? undefined : skillSource;
            if (currentlyEnabled) {
                await phrenClient.disableSkill(skillName, project);
            }
            else {
                await phrenClient.enableSkill(skillName, project);
            }
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Skill "${skillName}" ${currentlyEnabled ? "disabled" : "enabled"}.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to toggle skill: ${toErrorMessage(error)}`);
        }
    });
    const toggleHookDisposable = vscode.commands.registerCommand("phren.toggleHook", async (toolOrNode, currentlyEnabled) => {
        try {
            const tool = typeof toolOrNode === "string" ? toolOrNode : toolOrNode.tool;
            const enabled = typeof toolOrNode === "string" ? currentlyEnabled : toolOrNode.enabled;
            await phrenClient.toggleHooks(!enabled, tool);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Hooks for "${tool}" ${enabled ? "disabled" : "enabled"}.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to toggle hook: ${toErrorMessage(error)}`);
        }
    });
    const openTaskDisposable = vscode.commands.registerCommand("phren.openTask", (task) => {
        (0, taskViewer_1.showTaskDetail)(phrenClient, task, refreshTree);
    });
    const openQueueItemDisposable = vscode.commands.registerCommand("phren.openQueueItem", (item) => {
        (0, queueViewer_1.showQueueItemDetail)(phrenClient, item, refreshTree);
    });
    const openSessionOverviewDisposable = vscode.commands.registerCommand("phren.openSessionOverview", async (session) => {
        try {
            await (0, sessionViewer_1.showSessionOverview)(phrenClient, session);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to open session overview: ${toErrorMessage(error)}`);
        }
    });
    const copySessionIdDisposable = vscode.commands.registerCommand("phren.copySessionId", async (session) => {
        try {
            await vscode.env.clipboard.writeText(session.sessionId);
            await vscode.window.showInformationMessage(`Copied session ID ${session.sessionId.slice(0, 8)}.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to copy session ID: ${toErrorMessage(error)}`);
        }
    });
    // --- Add Task command ---
    const addTaskDisposable = vscode.commands.registerCommand("phren.addTask", async () => {
        let project = statusBar.getActiveProjectName();
        if (!project) {
            const projectsRaw = await phrenClient.listProjects();
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
                await vscode.window.showWarningMessage("No Phren projects found.");
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
            await phrenClient.addTask(project, trimmedTaskText);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Task added to ${project}`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to add task: ${toErrorMessage(error)}`);
        }
    });
    // --- Complete Task command (from tree view context menu) ---
    const completeTaskDisposable = vscode.commands.registerCommand("phren.completeTask", async (task) => {
        try {
            await phrenClient.completeTask(task.projectName, task.line);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Task "${task.id}" marked complete.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to complete task: ${toErrorMessage(error)}`);
        }
    });
    const removeTaskDisposable = vscode.commands.registerCommand("phren.removeTask", async (task) => {
        if (!task) {
            await vscode.window.showWarningMessage("Remove Task is available from the Phren explorer context menu.");
            return;
        }
        const confirmed = await vscode.window.showWarningMessage(`Delete task "${task.id}"?`, { modal: true, detail: task.line }, "Delete");
        if (confirmed !== "Delete")
            return;
        try {
            await phrenClient.removeTask(task.projectName, task.line);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Task "${task.id}" deleted.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to delete task: ${toErrorMessage(error)}`);
        }
    });
    // --- Remove Finding command ---
    const removeFindingDisposable = vscode.commands.registerCommand("phren.removeFinding", async (finding) => {
        if (finding) {
            // Called from tree view context menu
            const confirmed = await vscode.window.showWarningMessage(`Remove finding "${finding.id}"?`, { modal: true }, "Remove");
            if (confirmed !== "Remove")
                return;
            try {
                await phrenClient.removeFinding(finding.projectName, finding.text);
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
                const projectsRaw = await phrenClient.listProjects();
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
                await phrenClient.removeFinding(project, findingText.trim());
                treeDataProvider.refresh();
                await vscode.window.showInformationMessage("Finding removed.");
            }
            catch (error) {
                await vscode.window.showErrorMessage(`Failed to remove finding: ${toErrorMessage(error)}`);
            }
        }
    });
    const rejectQueueItemDisposable = vscode.commands.registerCommand("phren.rejectQueueItem", async (item) => {
        if (!item) {
            await vscode.window.showWarningMessage("Reject Queue Item is available from the Phren explorer context menu.");
            return;
        }
        const confirmed = await vscode.window.showWarningMessage(`Reject queue item "${item.id}"?`, { modal: true, detail: item.text }, "Reject");
        if (confirmed !== "Reject")
            return;
        try {
            await phrenClient.rejectQueueItem(item.projectName, item.text);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Queue item "${item.id}" rejected.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to reject queue item: ${toErrorMessage(error)}`);
        }
    });
    // --- Pin Memory command ---
    const pinMemoryDisposable = vscode.commands.registerCommand("phren.pinMemory", async () => {
        let project = statusBar.getActiveProjectName();
        if (!project) {
            const projectsRaw = await phrenClient.listProjects();
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
                await vscode.window.showWarningMessage("No Phren projects found.");
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
            await phrenClient.pinMemory(project, trimmedMemoryText);
            await vscode.window.showInformationMessage(`Memory pinned to ${project}`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to pin memory: ${toErrorMessage(error)}`);
        }
    });
    const syncDisposable = vscode.commands.registerCommand("phren.sync", async () => {
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Phren: Syncing...", cancellable: false }, async () => {
                await phrenClient.pushChanges();
            });
            treeDataProvider.refresh();
            // Re-poll health immediately so the status bar updates
            await statusBar.initialize();
            await vscode.window.showInformationMessage("Phren: Sync complete.");
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Phren sync failed: ${toErrorMessage(error)}`);
        }
    });
    // --- Doctor command ---
    const doctorDisposable = vscode.commands.registerCommand("phren.doctor", async () => {
        try {
            const raw = await phrenClient.healthCheck();
            const data = asRecord(asRecord(raw)?.data);
            outputChannel.clear();
            outputChannel.appendLine("=== Phren Doctor ===");
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
                        outputChannel.appendLine(`  Fragments: ${index.entityCount}`);
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
            await vscode.window.showErrorMessage(`Phren doctor failed: ${toErrorMessage(error)}`);
        }
    });
    // --- Hooks Status command ---
    const hooksStatusDisposable = vscode.commands.registerCommand("phren.hooksStatus", async () => {
        try {
            const raw = await phrenClient.listHooks();
            const data = asRecord(asRecord(raw)?.data);
            outputChannel.clear();
            outputChannel.appendLine("=== Phren Hooks Status ===");
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
    const toggleHooksCommandDisposable = vscode.commands.registerCommand("phren.toggleHooksCommand", async () => {
        try {
            const raw = await phrenClient.listHooks();
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
            await phrenClient.toggleHooks(!currentlyEnabled, choice.label);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Hooks for "${choice.label}" ${currentlyEnabled ? "disabled" : "enabled"}.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to toggle hooks: ${toErrorMessage(error)}`);
        }
    });
    // --- Manage Project command ---
    const manageProjectDisposable = vscode.commands.registerCommand("phren.manageProject", async () => {
        try {
            const projectsRaw = await phrenClient.listProjects();
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
            await phrenClient.manageProject(projectChoice, action);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Project "${projectChoice}" ${action}d.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to manage project: ${toErrorMessage(error)}`);
        }
    });
    const uninstallDisposable = vscode.commands.registerCommand("phren.uninstall", async () => {
        const proceed = await vscode.window.showWarningMessage("Uninstall Phren from this machine?", {
            modal: true,
            detail: "This removes Phren MCP entries from editor configs, uninstalls the global npm package, and resets VS Code Phren settings.",
        }, "Uninstall Phren");
        if (proceed !== "Uninstall Phren") {
            return;
        }
        const deleteStoreChoice = await vscode.window.showWarningMessage(`Also delete ${GLOBAL_PHREN_STORE_PATH}?`, {
            modal: true,
            detail: "This permanently deletes Phren memory and project data on this machine.",
        }, "Delete ~/.phren", "Keep Data");
        const deleteStore = deleteStoreChoice === "Delete ~/.phren";
        const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Phren: Uninstalling...", cancellable: false }, async (progress) => {
            progress.report({ message: "Clearing Phren MCP entries from editor configs..." });
            const cleanupResult = clearPhrenMcpEntries();
            progress.report({ message: `Running npm uninstall -g ${PHREN_PACKAGE_NAME}...` });
            const npmResult = uninstallGlobalPhrenPackage();
            progress.report({ message: "Resetting VS Code Phren extension settings..." });
            const resetResult = await resetPhrenExtensionSettings(context);
            let storeRemoval = { removed: false, skipped: true };
            if (deleteStore) {
                progress.report({ message: `Deleting ${GLOBAL_PHREN_STORE_PATH}...` });
                storeRemoval = removePhrenStore(GLOBAL_PHREN_STORE_PATH);
            }
            return { cleanupResult, npmResult, resetResult, storeRemoval };
        });
        outputChannel.appendLine("=== Phren Uninstall ===");
        for (const filePath of summary.cleanupResult.cleanedFiles) {
            outputChannel.appendLine(`Cleaned MCP entry: ${filePath}`);
        }
        for (const warning of summary.cleanupResult.warnings) {
            outputChannel.appendLine(`Warning: ${warning}`);
        }
        if (summary.npmResult.stdout) {
            outputChannel.appendLine(summary.npmResult.stdout.trim());
        }
        if (summary.npmResult.stderr) {
            outputChannel.appendLine(summary.npmResult.stderr.trim());
        }
        for (const warning of summary.resetResult.warnings) {
            outputChannel.appendLine(`Warning: ${warning}`);
        }
        if (deleteStore) {
            if (summary.storeRemoval.removed) {
                outputChannel.appendLine(`Removed ${GLOBAL_PHREN_STORE_PATH}`);
            }
            else if (summary.storeRemoval.error) {
                outputChannel.appendLine(`Warning: ${summary.storeRemoval.error}`);
            }
        }
        outputChannel.appendLine("=== End ===");
        const failedSteps = [];
        if (!summary.npmResult.ok)
            failedSteps.push("global npm uninstall");
        if (summary.storeRemoval.error)
            failedSteps.push("~/.phren deletion");
        if (summary.resetResult.warnings.length > 0)
            failedSteps.push("settings reset (partial)");
        treeDataProvider.refresh();
        if (failedSteps.length > 0) {
            await vscode.window.showWarningMessage(`Phren uninstall finished with warnings (${failedSteps.join(", ")}). See the Phren output channel for details.`);
            outputChannel.show(true);
            return;
        }
        await vscode.window.showInformationMessage(`Phren uninstall complete. Removed ${summary.cleanupResult.cleanedFiles.length} MCP entr${summary.cleanupResult.cleanedFiles.length === 1 ? "y" : "ies"}${deleteStore ? " and deleted ~/.phren" : ""}.`);
    });
    const openMachinesConfigDisposable = vscode.commands.registerCommand("phren.openMachinesConfig", async () => {
        try {
            const machinesPath = (0, profileConfig_1.machinesConfigPath)(runtimeConfig.storePath);
            if (!fs.existsSync(machinesPath)) {
                fs.mkdirSync(path.dirname(machinesPath), { recursive: true });
                fs.writeFileSync(machinesPath, "# machine-name: profile-name\n", "utf8");
            }
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(machinesPath));
            await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to open machines.yaml: ${toErrorMessage(error)}`);
        }
    });
    const promptForReload = async (message, extraAction) => {
        const choices = extraAction ? ["Reload Window", extraAction.label, "Later"] : ["Reload Window", "Later"];
        const choice = await vscode.window.showInformationMessage(message, ...choices);
        if (choice === "Reload Window") {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
            return;
        }
        if (extraAction && choice === extraAction.label) {
            await extraAction.run();
        }
    };
    // --- Set this machine's profile mapping ---
    const switchProfileDisposable = vscode.commands.registerCommand("phren.switchProfile", async () => {
        try {
            const machine = (0, profileConfig_1.readMachineName)();
            const current = (0, profileConfig_1.readDeviceContext)(runtimeConfig.storePath);
            const profiles = (0, profileConfig_1.listProfileConfigs)(runtimeConfig.storePath);
            if (profiles.length === 0) {
                await vscode.window.showInformationMessage("No profiles found in the Phren store.", "Open machines.yaml")
                    .then(async (choice) => {
                    if (choice === "Open machines.yaml") {
                        await vscode.commands.executeCommand("phren.openMachinesConfig");
                    }
                });
                return;
            }
            const picks = profiles.map((profile) => ({
                label: profile.name,
                description: profile.name === current.profile ? "current" : undefined,
                detail: `${profile.projects.length} project${profile.projects.length === 1 ? "" : "s"}${profile.description ? ` • ${profile.description}` : ""}`,
            }));
            const choice = await vscode.window.showQuickPick(picks, {
                title: `Set profile for machine "${machine}"`,
                placeHolder: "This writes the real machine -> profile mapping in machines.yaml",
            });
            if (!choice)
                return;
            if (choice.label === current.profile) {
                await vscode.window.showInformationMessage(`Machine "${machine}" already uses profile "${choice.label}".`);
                return;
            }
            const machinesPath = (0, profileConfig_1.setMachineProfile)(runtimeConfig.storePath, machine, choice.label);
            treeDataProvider.refresh();
            await promptForReload(`Mapped machine "${machine}" to profile "${choice.label}" in machines.yaml. Reload VS Code to restart the Phren backend on the new profile.`, {
                label: "Open machines.yaml",
                run: async () => {
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(machinesPath));
                    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
                },
            });
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to update machine profile mapping: ${toErrorMessage(error)}`);
        }
    });
    const configureMachineDisposable = vscode.commands.registerCommand("phren.configureMachine", async () => {
        try {
            const currentMachine = (0, profileConfig_1.readMachineName)();
            const nextMachine = await vscode.window.showInputBox({
                title: "Set machine alias",
                prompt: "Stored in ~/.phren/.machine-id and used to look up this machine in machines.yaml",
                value: currentMachine,
                validateInput: (value) => value.trim() ? null : "Machine name cannot be empty",
            });
            if (!nextMachine) {
                return;
            }
            const normalized = nextMachine.trim();
            if (normalized === currentMachine) {
                await vscode.window.showInformationMessage(`Machine alias is already "${normalized}".`);
                return;
            }
            (0, profileConfig_1.writeMachineName)(normalized);
            treeDataProvider.refresh();
            await promptForReload(`Saved machine alias "${normalized}" to ${(0, profileConfig_1.machineIdPath)()}. Reload VS Code so Phren resolves the new machine identity.`, {
                label: "Open machines.yaml",
                run: async () => {
                    await vscode.commands.executeCommand("phren.openMachinesConfig");
                },
            });
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to update machine alias: ${toErrorMessage(error)}`);
        }
    });
    const filterFindingsByDateDisposable = vscode.commands.registerCommand("phren.filterFindingsByDate", async () => {
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
    context.subscriptions.push(setActiveProjectDisposable, addFindingDisposable, searchDisposable, showGraphDisposable, refreshDisposable, openFindingDisposable, openProjectFileDisposable, openSkillDisposable, toggleSkillDisposable, toggleHookDisposable, openTaskDisposable, openQueueItemDisposable, openSessionOverviewDisposable, copySessionIdDisposable, filterFindingsByDateDisposable, switchProfileDisposable, configureMachineDisposable, openMachinesConfigDisposable, syncDisposable, doctorDisposable, hooksStatusDisposable, toggleHooksCommandDisposable, manageProjectDisposable, uninstallDisposable, addTaskDisposable, completeTaskDisposable, removeTaskDisposable, removeFindingDisposable, rejectQueueItemDisposable, pinMemoryDisposable);
    // --- Sync VS Code settings to phren preference files ---
    syncSettingsToPreferences(runtimeConfig.storePath, config);
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration("phren.proactivity") ||
            e.affectsConfiguration("phren.proactivityFindings") ||
            e.affectsConfiguration("phren.proactivityTasks") ||
            e.affectsConfiguration("phren.autoExtract") ||
            e.affectsConfiguration("phren.autoCapture") ||
            e.affectsConfiguration("phren.taskMode") ||
            e.affectsConfiguration("phren.hooksEnabled") ||
            e.affectsConfiguration("phren.semanticDedup") ||
            e.affectsConfiguration("phren.semanticConflict") ||
            e.affectsConfiguration("phren.llmModel") ||
            e.affectsConfiguration("phren.findingSensitivity")) {
            const updated = vscode.workspace.getConfiguration("phren");
            syncSettingsToPreferences(runtimeConfig.storePath, updated);
            outputChannel.appendLine("Phren settings synced to preference files.");
            // Notify when semantic features are toggled on
            const semanticDedup = updated.get("semanticDedup", false);
            const semanticConflict = updated.get("semanticConflict", false);
            const llmModel = updated.get("llmModel", "") || "claude-haiku-4-5-20251001 (default)";
            const expensiveModels = ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-4o"];
            const isExpensive = expensiveModels.some(m => llmModel.includes(m));
            if (e.affectsConfiguration("phren.semanticDedup") && semanticDedup) {
                const msg = `Phren: Semantic dedup enabled for offline batch operations (consolidate, extract). Model: ${llmModel}. ~$0.01/batch-session with Haiku. Live dedup uses the active agent — no extra cost.`;
                if (isExpensive) {
                    await vscode.window.showWarningMessage(`${msg} Warning: expensive model selected — Haiku recommended for batch operations.`);
                }
                else {
                    await vscode.window.showInformationMessage(msg);
                }
            }
            if (e.affectsConfiguration("phren.semanticConflict") && semanticConflict) {
                const msg = `Phren: Semantic conflict detection enabled for offline batch operations (consolidate, extract). Model: ${llmModel}. ~$0.01/batch-session with Haiku. Live conflict detection uses the active agent — no extra cost.`;
                if (isExpensive) {
                    await vscode.window.showWarningMessage(`${msg} Warning: expensive model selected — Haiku recommended for batch operations.`);
                }
                else {
                    await vscode.window.showInformationMessage(msg);
                }
            }
            if (e.affectsConfiguration("phren.llmModel") && isExpensive && (semanticDedup || semanticConflict)) {
                await vscode.window.showWarningMessage(`Phren: "${llmModel}" is expensive for offline batch operations. Haiku is recommended and costs ~10x less.`, "Switch to Haiku").then(async (choice) => {
                    if (choice === "Switch to Haiku") {
                        await updated.update("llmModel", "claude-haiku-4-5-20251001", vscode.ConfigurationTarget.Global);
                    }
                });
            }
            if (e.affectsConfiguration("phren.findingSensitivity")) {
                const sensitivity = updated.get("findingSensitivity", "balanced");
                const descriptions = {
                    minimal: "Only save findings when explicitly asked. No auto-capture.",
                    conservative: "Save decisions and pitfalls only. Auto-capture: 3/session max.",
                    balanced: "Save non-obvious patterns and decisions. Auto-capture: 10/session.",
                    aggressive: "Save everything worth remembering. Auto-capture: 20/session.",
                };
                const desc = descriptions[sensitivity] ?? "";
                await vscode.window.showInformationMessage(`Phren: Finding sensitivity set to "${sensitivity}". ${desc}`);
            }
        }
    });
    context.subscriptions.push(configChangeDisposable);
    try {
        await statusBar.initialize();
        outputChannel.appendLine("Status bar initialized successfully");
    }
    catch (error) {
        outputChannel.appendLine(`Status bar init failed: ${toErrorMessage(error)}`);
        await vscode.window.showErrorMessage(`Failed to initialize active Phren project: ${toErrorMessage(error)}`);
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
async function runOnboardingIfNeeded(config) {
    const completed = config.get(ONBOARDING_COMPLETE_SETTING, false);
    if (completed) {
        return;
    }
    outputChannel.appendLine("Running first-time Phren onboarding...");
    try {
        const globallyInstalled = await isGlobalPhrenInstalled();
        if (!globallyInstalled) {
            const installChoice = await vscode.window.showInformationMessage("Phren is not installed globally. Install it now to enable the extension backend?", "Install Phren", "Skip");
            if (installChoice === "Install Phren") {
                const result = await runCommandWithProgress("Installing Phren globally...", getNpmCommand(), ["install", "-g", PHREN_PACKAGE_NAME]);
                if (result.ok) {
                    await vscode.window.showInformationMessage("Phren global install complete.");
                }
                else {
                    await vscode.window.showErrorMessage(`Phren install failed: ${summarizeCommandError(result)}`);
                }
            }
        }
        if (!(0, runtimeConfig_1.pathExists)(GLOBAL_PHREN_STORE_PATH)) {
            const initChoice = await vscode.window.showInformationMessage(`${GLOBAL_PHREN_STORE_PATH} was not found. Initialize Phren now?`, "Initialize Phren", "Skip");
            if (initChoice === "Initialize Phren") {
                const result = await runCommandWithProgress("Initializing Phren store...", getNpxCommand(), [PHREN_PACKAGE_NAME, "init", "--yes"]);
                if (result.ok) {
                    await vscode.window.showInformationMessage("Phren store initialized.");
                }
                else {
                    await vscode.window.showErrorMessage(`Phren init failed: ${summarizeCommandError(result)}`);
                }
            }
        }
        if (!hasPhrenMcpEntry()) {
            const configureChoice = await vscode.window.showInformationMessage("Phren MCP entry is missing in ~/.claude/settings.json. Configure it now?", "Configure MCP", "Skip");
            if (configureChoice === "Configure MCP") {
                const result = await runCommandWithProgress("Configuring Phren MCP entry...", getNpxCommand(), [PHREN_PACKAGE_NAME, "init", "--yes"]);
                if (result.ok) {
                    await vscode.window.showInformationMessage("Phren MCP configuration updated.");
                }
                else {
                    await vscode.window.showErrorMessage(`Phren MCP configuration failed: ${summarizeCommandError(result)}`);
                }
            }
        }
        const workspaceFolder = getPrimaryWorkspaceFolderPath();
        if (workspaceFolder) {
            const addProjectChoice = await vscode.window.showInformationMessage(`Track this workspace in Phren?\n${workspaceFolder}`, "Track Project", "Skip");
            if (addProjectChoice === "Track Project") {
                const result = await runCommandWithProgress("Adding workspace to Phren projects...", getNpxCommand(), [PHREN_PACKAGE_NAME, "add", workspaceFolder]);
                if (result.ok) {
                    await vscode.window.showInformationMessage("Workspace added to Phren projects.");
                }
                else {
                    await vscode.window.showErrorMessage(`Failed to add project: ${summarizeCommandError(result)}`);
                }
            }
        }
    }
    finally {
        try {
            await config.update(ONBOARDING_COMPLETE_SETTING, true, vscode.ConfigurationTarget.Global);
            outputChannel.appendLine("Phren onboarding complete (phren.onboardingComplete=true).");
        }
        catch (error) {
            outputChannel.appendLine(`Failed to persist onboarding flag: ${toErrorMessage(error)}`);
        }
    }
}
async function isGlobalPhrenInstalled() {
    const result = await runCommand(getNpmCommand(), ["list", "-g", PHREN_PACKAGE_NAME, "--json"]);
    const parsed = safeParseJson(result.stdout);
    const dependencies = asRecord(parsed?.dependencies);
    const packageEntry = dependencies ? dependencies[PHREN_PACKAGE_NAME] : undefined;
    return Boolean(packageEntry);
}
function getNpmCommand() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
}
function getNpxCommand() {
    return process.platform === "win32" ? "npx.cmd" : "npx";
}
function getPrimaryWorkspaceFolderPath() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    return folders[0]?.uri.fsPath;
}
function hasPhrenMcpEntry() {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    if (!fs.existsSync(settingsPath)) {
        return false;
    }
    try {
        const raw = fs.readFileSync(settingsPath, "utf8");
        const json = safeParseJson(raw);
        const mcpServers = asRecord(json?.mcpServers);
        const servers = asRecord(json?.servers);
        return Boolean(mcpServers?.phren || servers?.phren);
    }
    catch (error) {
        outputChannel.appendLine(`Failed to read ${settingsPath}: ${toErrorMessage(error)}`);
        return false;
    }
}
async function runCommandWithProgress(title, command, args) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, async () => runCommand(command, args));
}
async function runCommand(command, args) {
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)(command, args, { shell: false });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            resolve({
                ok: false,
                status: null,
                stdout,
                stderr: `${stderr}\n${toErrorMessage(error)}`.trim(),
            });
        });
        child.on("close", (status) => {
            resolve({
                ok: status === 0,
                status,
                stdout,
                stderr,
            });
        });
    });
}
function safeParseJson(raw) {
    try {
        const value = JSON.parse(raw);
        return asRecord(value);
    }
    catch {
        return undefined;
    }
}
function summarizeCommandError(result) {
    if (result.stderr.trim()) {
        return result.stderr.trim().split("\n").slice(-1)[0];
    }
    if (result.stdout.trim()) {
        return result.stdout.trim().split("\n").slice(-1)[0];
    }
    return result.status === null ? "failed to start command" : `exit code ${result.status}`;
}
function clearPhrenMcpEntries() {
    const cleanedFiles = [];
    const warnings = [];
    const candidateFiles = getMcpConfigCandidateFiles();
    for (const filePath of candidateFiles) {
        try {
            if (removeMcpServerAtPath(filePath)) {
                cleanedFiles.push(filePath);
            }
        }
        catch (error) {
            warnings.push(`${filePath}: ${toErrorMessage(error)}`);
        }
    }
    const codexTomlPath = path.join(os.homedir(), ".codex", "config.toml");
    try {
        if (removeTomlMcpServer(codexTomlPath)) {
            cleanedFiles.push(codexTomlPath);
        }
    }
    catch (error) {
        warnings.push(`${codexTomlPath}: ${toErrorMessage(error)}`);
    }
    return { cleanedFiles, warnings };
}
function getMcpConfigCandidateFiles() {
    const home = os.homedir();
    const files = [
        path.join(home, ".claude", "settings.json"),
        path.join(home, ".cursor", "mcp.json"),
    ];
    return Array.from(new Set(files.filter((value) => Boolean(value))));
}
function removeMcpServerAtPath(filePath) {
    if (!fs.existsSync(filePath))
        return false;
    let data;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return false;
        data = parsed;
    }
    catch (error) {
        throw new Error(`malformed JSON: ${toErrorMessage(error)}`);
    }
    let removed = false;
    for (const key of ["mcpServers", "servers"]) {
        const root = data[key];
        if (!root || typeof root !== "object" || Array.isArray(root))
            continue;
        const objectRoot = root;
        if (Object.prototype.hasOwnProperty.call(objectRoot, "phren")) {
            delete objectRoot.phren;
            removed = true;
        }
    }
    if (removed) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
    }
    return removed;
}
function removeTomlMcpServer(filePath) {
    if (!fs.existsSync(filePath))
        return false;
    const content = fs.readFileSync(filePath, "utf8");
    const sectionRe = /^\[mcp_servers\.phren\]\s*\n(?:(?!\[)[^\n]*\n?)*/m;
    if (!sectionRe.test(content))
        return false;
    const next = content.replace(sectionRe, "").replace(/\n{3,}/g, "\n\n");
    fs.writeFileSync(filePath, next, "utf8");
    return true;
}
function uninstallGlobalPhrenPackage() {
    try {
        const result = (0, child_process_1.spawnSync)("npm", ["uninstall", "-g", PHREN_PACKAGE_NAME], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return {
            ok: result.status === 0,
            status: result.status,
            stdout: typeof result.stdout === "string" ? result.stdout : "",
            stderr: typeof result.stderr === "string" ? result.stderr : "",
        };
    }
    catch (error) {
        return {
            ok: false,
            status: null,
            stdout: "",
            stderr: toErrorMessage(error),
        };
    }
}
function removePhrenStore(storePath) {
    if (!fs.existsSync(storePath))
        return { removed: false, skipped: true };
    try {
        fs.rmSync(storePath, { recursive: true, force: true });
        return { removed: true, skipped: false };
    }
    catch (error) {
        return { removed: false, skipped: false, error: toErrorMessage(error) };
    }
}
async function resetPhrenExtensionSettings(context) {
    const warnings = [];
    const resetKeys = [];
    const config = vscode.workspace.getConfiguration("phren");
    const packageJson = context.extension.packageJSON;
    const contributes = asRecord(packageJson.contributes);
    const configuration = asRecord(contributes?.configuration);
    const properties = asRecord(configuration?.properties) ?? {};
    const keys = Object.keys(properties).filter((key) => key.startsWith("phren."));
    for (const key of keys) {
        const section = key.slice("phren.".length);
        try {
            await config.update(section, undefined, vscode.ConfigurationTarget.Global);
            resetKeys.push(key);
        }
        catch (error) {
            warnings.push(`${key}: ${toErrorMessage(error)}`);
        }
    }
    return { resetKeys, warnings };
}
/**
 * Synchronous file lock matching the protocol used by the phren MCP server
 * (governance-locks.ts). Lock file is `filePath + ".lock"`, created with the
 * O_EXCL flag. Both processes must use this convention for mutual exclusion to work.
 */
function withFileLockSync(filePath, fn) {
    const lockPath = filePath + ".lock";
    const maxWait = 5000;
    const pollInterval = 100;
    const staleThreshold = 30000;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let waited = 0;
    let hasLock = false;
    // Use Atomics.wait for cross-platform sleep without busy-spin
    const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
    const sleep = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);
    while (waited < maxWait) {
        try {
            fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
            hasLock = true;
            break;
        }
        catch {
            // Lock held — check for staleness
            try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > staleThreshold) {
                    try {
                        fs.unlinkSync(lockPath);
                    }
                    catch { /* ignore */ }
                    continue;
                }
            }
            catch { /* lock file may have been released between checks */ }
            sleep(pollInterval);
            waited += pollInterval;
        }
    }
    if (!hasLock) {
        // Best-effort: proceed without lock rather than silently dropping the write
        try {
            return fn();
        }
        catch {
            return {};
        }
    }
    try {
        return fn();
    }
    finally {
        try {
            fs.unlinkSync(lockPath);
        }
        catch { /* ignore */ }
    }
}
function readJsonFileSafe(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        }
    }
    catch {
        // Corrupt or missing file — start fresh
    }
    return {};
}
function writeJsonFileAtomic(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmpPath, filePath);
}
function patchJsonFile(filePath, patch) {
    withFileLockSync(filePath, () => {
        const current = readJsonFileSafe(filePath);
        writeJsonFileAtomic(filePath, { ...current, ...patch, updatedAt: new Date().toISOString() });
    });
}
function syncSettingsToPreferences(storePath, config) {
    try {
        const governancePrefsPath = path.join(storePath, ".governance", "install-preferences.json");
        const runtimePrefsPath = path.join(storePath, ".runtime", "install-preferences.json");
        const workflowPolicyPath = path.join(storePath, ".governance", "workflow-policy.json");
        // Proactivity → governance install-preferences.json
        const proactivity = config.get("proactivity", "");
        const proactivityFindings = config.get("proactivityFindings", "");
        const proactivityTasks = config.get("proactivityTasks", "");
        const governancePatch = {};
        if (proactivity && ["high", "medium", "low"].includes(proactivity)) {
            governancePatch.proactivity = proactivity;
        }
        if (proactivityFindings && ["high", "medium", "low"].includes(proactivityFindings)) {
            governancePatch.proactivityFindings = proactivityFindings;
        }
        if (proactivityTasks && ["high", "medium", "low"].includes(proactivityTasks)) {
            governancePatch.proactivityTask = proactivityTasks;
        }
        if (Object.keys(governancePatch).length > 0) {
            patchJsonFile(governancePrefsPath, governancePatch);
        }
        // Hooks enabled → runtime install-preferences.json
        const hooksEnabled = config.get("hooksEnabled", true);
        patchJsonFile(runtimePrefsPath, { hooksEnabled });
        // Auto-extract / auto-capture → runtime install-preferences.json
        const autoExtract = config.get("autoExtract", true);
        const autoCapture = config.get("autoCapture", false);
        patchJsonFile(runtimePrefsPath, { autoExtract, autoCapture });
        // Task mode → governance workflow-policy.json
        const taskMode = config.get("taskMode", "");
        if (taskMode && ["off", "manual", "suggest", "auto"].includes(taskMode)) {
            patchJsonFile(workflowPolicyPath, { taskMode });
        }
        // Semantic dedup/conflict + LLM model → runtime install-preferences.json
        const semanticDedup = config.get("semanticDedup", false);
        const semanticConflict = config.get("semanticConflict", false);
        const llmModel = config.get("llmModel", "");
        const semanticPatch = { semanticDedup, semanticConflict };
        if (llmModel)
            semanticPatch.llmModel = llmModel;
        patchJsonFile(runtimePrefsPath, semanticPatch);
        // Finding sensitivity → governance policy.json
        const findingSensitivity = config.get("findingSensitivity", "");
        if (findingSensitivity && ["minimal", "conservative", "balanced", "aggressive"].includes(findingSensitivity)) {
            const policyPath = path.join(storePath, ".governance", "policy.json");
            patchJsonFile(policyPath, { findingSensitivity });
        }
    }
    catch {
        // Best-effort: don't crash the extension if preference files can't be written
    }
}
//# sourceMappingURL=extension.js.map