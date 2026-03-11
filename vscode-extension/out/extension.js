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
const cortexClient_1 = require("./cortexClient");
const CortexTreeProvider_1 = require("./providers/CortexTreeProvider");
const searchQuickPick_1 = require("./searchQuickPick");
const statusBar_1 = require("./statusBar");
const graphWebview_1 = require("./graphWebview");
const findingViewer_1 = require("./findingViewer");
const projectFileViewer_1 = require("./projectFileViewer");
const skillEditor_1 = require("./skillEditor");
const taskViewer_1 = require("./taskViewer");
let client;
let outputChannel;
async function activate(context) {
    outputChannel = vscode.window.createOutputChannel("Cortex");
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine("Cortex extension activating...");
    const config = vscode.workspace.getConfiguration("cortex");
    const mcpServerPath = config.get("mcpServerPath", "/home/alaarab/.nvm/versions/node/v24.13.0/lib/node_modulescortex/mcp/dist/index.js");
    const storePath = config.get("storePath", "/home/alaarab/.cortex");
    const nodePath = config.get("nodePath", "node");
    const cortexClient = new cortexClient_1.CortexClient({
        mcpServerPath,
        storePath,
        nodePath,
    });
    client = cortexClient;
    const treeDataProvider = new CortexTreeProvider_1.CortexTreeProvider(cortexClient);
    const treeView = vscode.window.createTreeView("cortex.explorer", {
        treeDataProvider,
    });
    const statusBar = new statusBar_1.CortexStatusBar(cortexClient);
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
    const toggleHookDisposable = vscode.commands.registerCommand("cortex.toggleHook", async (tool, currentlyEnabled) => {
        try {
            await cortexClient.toggleHooks(!currentlyEnabled, tool);
            treeDataProvider.refresh();
            await vscode.window.showInformationMessage(`Hooks for "${tool}" ${currentlyEnabled ? "disabled" : "enabled"}.`);
        }
        catch (error) {
            await vscode.window.showErrorMessage(`Failed to toggle hook: ${toErrorMessage(error)}`);
        }
    });
    const openTaskDisposable = vscode.commands.registerCommand("cortex.openTask", (task) => {
        (0, taskViewer_1.showTaskDetail)(cortexClient, task, refreshTree);
    });
    context.subscriptions.push(setActiveProjectDisposable, addFindingDisposable, searchDisposable, showGraphDisposable, refreshDisposable, openFindingDisposable, openProjectFileDisposable, openSkillDisposable, toggleSkillDisposable, toggleHookDisposable, openTaskDisposable);
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
//# sourceMappingURL=extension.js.map