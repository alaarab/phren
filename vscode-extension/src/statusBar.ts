import * as vscode from "vscode";
import { CortexClient } from "./cortexClient";

interface ProjectSummary {
  name: string;
}

export class CortexStatusBar implements vscode.Disposable {
  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private activeProjectName?: string;

  constructor(private readonly client: CortexClient) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.command = "cortex.setActiveProject";
    this.statusItem.tooltip = "Set active Cortex project";

    this.disposables.push(
      this.statusItem,
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.render();
      }),
    );

    this.render();
    this.statusItem.show();
  }

  async initialize(): Promise<void> {
    const projectNames = await this.fetchProjectNames();
    this.activeProjectName = this.activeProjectName && projectNames.includes(this.activeProjectName)
      ? this.activeProjectName
      : projectNames[0];
    this.render();
  }

  getActiveProjectName(): string | undefined {
    return this.activeProjectName;
  }

  setActiveProjectName(projectName: string | undefined): void {
    this.activeProjectName = projectName;
    this.render();
  }

  async promptForActiveProject(): Promise<string | undefined> {
    const projectNames = await this.fetchProjectNames();
    if (projectNames.length === 0) {
      await vscode.window.showWarningMessage("No Cortex projects found.");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(projectNames, {
      title: "Set Active Cortex Project",
      placeHolder: "Select a Cortex project",
      canPickMany: false,
    });
    if (!selected) {
      return undefined;
    }

    this.setActiveProjectName(selected);
    return selected;
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private async fetchProjectNames(): Promise<string[]> {
    const raw = await this.client.listProjects();
    const projects = this.parseProjects(raw);
    return projects.map((project) => project.name);
  }

  private parseProjects(value: unknown): ProjectSummary[] {
    const data = responseData(value);
    const projects = asArray(data?.projects);
    const parsed: ProjectSummary[] = [];

    for (const entry of projects) {
      const record = asRecord(entry);
      const name = asString(record?.name);
      if (!name) {
        continue;
      }

      parsed.push({ name });
    }

    return parsed;
  }

  private render(): void {
    const projectName = this.activeProjectName ?? "No project";
    this.statusItem.text = `$(database) Cortex: ${projectName}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function responseData(value: unknown): Record<string, unknown> | undefined {
  const response = asRecord(value);
  return asRecord(response?.data);
}
