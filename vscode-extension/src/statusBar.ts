import * as vscode from "vscode";
import { PhrenClient } from "./phrenClient";

interface ProjectSummary {
  name: string;
}

const HEALTH_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class PhrenStatusBar implements vscode.Disposable {
  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private activeProjectName?: string;
  private healthOk: boolean | undefined;
  private healthTimer?: ReturnType<typeof setInterval>;
  private onHealthChanged?: (ok: boolean) => void;

  constructor(private readonly client: PhrenClient) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.command = "phren.doctor";
    this.statusItem.tooltip = "Phren health — click for Doctor";

    this.disposables.push(
      this.statusItem,
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.render();
      }),
    );

    this.render();
    this.statusItem.show();
  }

  /** Register a callback invoked whenever health status changes. */
  setOnHealthChanged(cb: (ok: boolean) => void): void {
    this.onHealthChanged = cb;
  }

  async initialize(): Promise<void> {
    const projectNames = await this.fetchProjectNames();
    this.activeProjectName = this.activeProjectName && projectNames.includes(this.activeProjectName)
      ? this.activeProjectName
      : projectNames[0];
    this.render();

    // Start health polling
    await this.pollHealth();
    this.healthTimer = setInterval(() => { this.pollHealth().catch(() => {}); }, HEALTH_POLL_INTERVAL_MS);
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
      await vscode.window.showWarningMessage("No Phren projects found.");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(projectNames, {
      title: "Set Active Phren Project",
      placeHolder: "Select a Phren project",
      canPickMany: false,
    });
    if (!selected) {
      return undefined;
    }

    this.setActiveProjectName(selected);
    return selected;
  }

  dispose(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private async pollHealth(): Promise<void> {
    try {
      const raw = await this.client.healthCheck();
      const data = asRecord(asRecord(raw)?.data);
      const ok = data !== undefined;
      const changed = this.healthOk !== ok;
      this.healthOk = ok;
      this.render();
      if (changed && this.onHealthChanged) {
        this.onHealthChanged(ok);
      }
    } catch {
      const changed = this.healthOk !== false;
      this.healthOk = false;
      this.render();
      if (changed && this.onHealthChanged) {
        this.onHealthChanged(false);
      }
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
    const healthIcon = this.healthOk === true ? "$(pass-filled)" : this.healthOk === false ? "$(error)" : "$(loading~spin)";
    this.statusItem.text = `$(hubot) ${projectName} ${healthIcon}`;
    this.statusItem.tooltip = this.healthOk === false
      ? "Phren is unhealthy — click for Doctor"
      : `Phren: ${projectName} — click for Doctor`;
    this.statusItem.color = this.healthOk === false ? "#f44336" : "#B8AED8";
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
