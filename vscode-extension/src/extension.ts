import * as vscode from "vscode";
import { CortexClient } from "./cortexClient";

const COMMAND_IDS = [
  "cortex.searchKnowledge",
  "cortex.getFindings",
  "cortex.getTasks",
  "cortex.addFinding",
  "cortex.listProjects",
  "cortex.getProjectSummary",
] as const;

let client: CortexClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("cortex");
  const mcpServerPath = config.get<string>(
    "mcpServerPath",
    "/home/alaarab/.nvm/versions/node/v24.13.0/lib/node_modules/@alaarab/cortex/mcp/dist/index.js",
  );
  const storePath = config.get<string>("storePath", "/home/alaarab/.cortex");

  client = new CortexClient({
    mcpServerPath,
    storePath,
  });

  for (const commandId of COMMAND_IDS) {
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
