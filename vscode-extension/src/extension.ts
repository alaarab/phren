import * as vscode from "vscode";
import { CortexClient } from "./cortexClient";
import { CortexTreeProvider } from "./providers/CortexTreeProvider";
import { showSearchQuickPick } from "./searchQuickPick";
import { CortexStatusBar } from "./statusBar";
import { showGraphWebview } from "./graphWebview";
import { showFindingDetail } from "./findingViewer";
import { showProjectFile } from "./projectFileViewer";
import { showSkillEditor } from "./skillEditor";
import { showTaskDetail } from "./taskViewer";

let client: CortexClient | undefined;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Cortex");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine("Cortex extension activating...");
  const config = vscode.workspace.getConfiguration("cortex");
  const mcpServerPath = config.get<string>(
    "mcpServerPath",
    "/home/alaarab/.nvm/versions/node/v24.13.0/lib/node_modulescortex/mcp/dist/index.js",
  );
  const storePath = config.get<string>("storePath", "/home/alaarab/.cortex");
  const nodePath = config.get<string>("nodePath", "node");

  const cortexClient = new CortexClient({
    mcpServerPath,
    storePath,
    nodePath,
  });
  client = cortexClient;

  const treeDataProvider = new CortexTreeProvider(cortexClient);
  const treeView = vscode.window.createTreeView("cortex.explorer", {
    treeDataProvider,
  });
  const statusBar = new CortexStatusBar(cortexClient);

  context.subscriptions.push(treeDataProvider, treeView, statusBar);

  const setActiveProjectDisposable = vscode.commands.registerCommand("cortex.setActiveProject", async () => {
    try {
      await statusBar.promptForActiveProject();
    } catch (error) {
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
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to add finding: ${toErrorMessage(error)}`);
    }
  });

  const searchDisposable = vscode.commands.registerCommand("cortex.search", async () => {
    try {
      await showSearchQuickPick(cortexClient);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to search Cortex knowledge: ${toErrorMessage(error)}`);
    }
  });

  const showGraphDisposable = vscode.commands.registerCommand("cortex.showGraph", async () => {
    try {
      await showGraphWebview(cortexClient, context);
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to show Cortex graph: ${toErrorMessage(error)}`);
    }
  });

  const refreshDisposable = vscode.commands.registerCommand("cortex.refresh", async () => {
    treeDataProvider.refresh();

    try {
      await statusBar.initialize();
    } catch (error) {
      await vscode.window.showErrorMessage(`Failed to refresh Cortex extension state: ${toErrorMessage(error)}`);
    }
  });

  const refreshTree = () => treeDataProvider.refresh();

  const openFindingDisposable = vscode.commands.registerCommand(
    "cortex.openFinding",
    (finding: { projectName: string; id: string; date: string; text: string }) => {
      showFindingDetail(cortexClient, finding, refreshTree);
    },
  );

  const openProjectFileDisposable = vscode.commands.registerCommand(
    "cortex.openProjectFile",
    async (projectName: string, fileName: string) => {
      try {
        await showProjectFile(cortexClient, projectName, fileName);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to open project file: ${toErrorMessage(error)}`);
      }
    },
  );

  const openSkillDisposable = vscode.commands.registerCommand(
    "cortex.openSkill",
    async (skillName: string, skillSource: string) => {
      try {
        await showSkillEditor(cortexClient, skillName, skillSource);
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to open skill: ${toErrorMessage(error)}`);
      }
    },
  );

  const toggleSkillDisposable = vscode.commands.registerCommand(
    "cortex.toggleSkill",
    async (skillName: string, skillSource: string, currentlyEnabled: boolean) => {
      try {
        const project = skillSource === "global" ? undefined : skillSource;
        if (currentlyEnabled) {
          await cortexClient.disableSkill(skillName, project);
        } else {
          await cortexClient.enableSkill(skillName, project);
        }
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(
          `Skill "${skillName}" ${currentlyEnabled ? "disabled" : "enabled"}.`,
        );
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to toggle skill: ${toErrorMessage(error)}`);
      }
    },
  );

  const toggleHookDisposable = vscode.commands.registerCommand(
    "cortex.toggleHook",
    async (tool: string, currentlyEnabled: boolean) => {
      try {
        await cortexClient.toggleHooks(!currentlyEnabled, tool);
        treeDataProvider.refresh();
        await vscode.window.showInformationMessage(
          `Hooks for "${tool}" ${currentlyEnabled ? "disabled" : "enabled"}.`,
        );
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to toggle hook: ${toErrorMessage(error)}`);
      }
    },
  );

  const openTaskDisposable = vscode.commands.registerCommand(
    "cortex.openTask",
    (task: { projectName: string; id: string; line: string; section: string; checked: boolean }) => {
      showTaskDetail(cortexClient, task, refreshTree);
    },
  );

  context.subscriptions.push(
    setActiveProjectDisposable,
    addFindingDisposable,
    searchDisposable,
    showGraphDisposable,
    refreshDisposable,
    openFindingDisposable,
    openProjectFileDisposable,
    openSkillDisposable,
    toggleSkillDisposable,
    toggleHookDisposable,
    openTaskDisposable,
  );

  try {
    await statusBar.initialize();
    outputChannel.appendLine("Status bar initialized successfully");
  } catch (error) {
    outputChannel.appendLine(`Status bar init failed: ${toErrorMessage(error)}`);
    await vscode.window.showErrorMessage(`Failed to initialize active Cortex project: ${toErrorMessage(error)}`);
  }
}

export async function deactivate(): Promise<void> {
  if (!client) {
    return;
  }

  await client.dispose();
  client = undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
