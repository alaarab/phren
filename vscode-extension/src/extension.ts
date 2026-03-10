import * as vscode from "vscode";
import { CortexClient } from "./cortexClient";
import { CortexTreeProvider } from "./providers/CortexTreeProvider";
import { showSearchQuickPick } from "./searchQuickPick";
import { CortexStatusBar } from "./statusBar";

const SCAFFOLDED_COMMAND_IDS = [
  "cortex.getFindings",
  "cortex.getTasks",
  "cortex.listProjects",
  "cortex.getProjectSummary",
] as const;

let client: CortexClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("cortex");
  const mcpServerPath = config.get<string>(
    "mcpServerPath",
    "/home/alaarab/.nvm/versions/node/v24.13.0/lib/node_modules/@alaarab/cortex/mcp/dist/index.js",
  );
  const storePath = config.get<string>("storePath", "/home/alaarab/.cortex");

  const cortexClient = new CortexClient({
    mcpServerPath,
    storePath,
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

  context.subscriptions.push(setActiveProjectDisposable, addFindingDisposable, searchDisposable);

  try {
    await statusBar.initialize();
  } catch (error) {
    await vscode.window.showErrorMessage(`Failed to initialize active Cortex project: ${toErrorMessage(error)}`);
  }

  for (const commandId of SCAFFOLDED_COMMAND_IDS) {
    const disposable = vscode.commands.registerCommand(commandId, async () => {
      await vscode.window.showInformationMessage(`${commandId} is scaffolded but not implemented yet.`);
    });
    context.subscriptions.push(disposable);
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
