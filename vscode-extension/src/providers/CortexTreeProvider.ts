import * as vscode from "vscode";
import { CortexClient } from "../cortexClient";

type BacklogSection = "Active" | "Queue" | "Done";
type CortexCategory = "findings" | "backlog" | "reference";

interface ProjectNode {
  kind: "project";
  projectName: string;
  brief?: string;
}

interface CategoryNode {
  kind: "category";
  projectName: string;
  category: CortexCategory;
}

interface FindingNode {
  kind: "finding";
  projectName: string;
  id: string;
  date: string;
  text: string;
}

interface TaskNode {
  kind: "task";
  projectName: string;
  id: string;
  line: string;
  section: BacklogSection;
  checked: boolean;
}

interface MessageNode {
  kind: "message";
  label: string;
  description?: string;
  iconId?: string;
}

type CortexNode = ProjectNode | CategoryNode | FindingNode | TaskNode | MessageNode;

interface ProjectSummary {
  name: string;
  brief?: string;
}

interface FindingSummary {
  id: string;
  date: string;
  text: string;
}

interface TaskSummary {
  id: string;
  line: string;
  section: BacklogSection;
  checked: boolean;
}

export class CortexTreeProvider implements vscode.TreeDataProvider<CortexNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<CortexNode | undefined | null>();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly client: CortexClient) {}

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  async getChildren(element?: CortexNode): Promise<CortexNode[]> {
    if (!element) {
      return this.getProjectNodes();
    }

    if (element.kind === "project") {
      return [
        { kind: "category", projectName: element.projectName, category: "findings" },
        { kind: "category", projectName: element.projectName, category: "backlog" },
        { kind: "category", projectName: element.projectName, category: "reference" },
      ];
    }

    if (element.kind === "category") {
      if (element.category === "findings") {
        return this.getFindingNodes(element.projectName);
      }
      if (element.category === "backlog") {
        return this.getBacklogNodes(element.projectName);
      }
      return [{ kind: "message", label: "coming soon", iconId: "clock" }];
    }

    return [];
  }

  getTreeItem(element: CortexNode): vscode.TreeItem {
    switch (element.kind) {
      case "project": {
        const item = new vscode.TreeItem(element.projectName, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = element.brief ? truncate(element.brief, 72) : undefined;
        item.iconPath = themeIcon("folder");
        item.id = `cortex.project.${element.projectName}`;
        return item;
      }
      case "category": {
        const categoryLabel = element.category[0].toUpperCase() + element.category.slice(1);
        const item = new vscode.TreeItem(categoryLabel, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = themeIcon(categoryIconId(element.category));
        item.id = `cortex.category.${element.projectName}.${element.category}`;
        return item;
      }
      case "finding": {
        const title = `${element.id} ${element.date}`;
        const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
        item.description = truncate(element.text, 96);
        item.tooltip = `${element.date}\n${element.text}`;
        item.iconPath = themeIcon("file");
        item.id = `cortex.finding.${element.projectName}.${element.id}`;
        return item;
      }
      case "task": {
        const item = new vscode.TreeItem(element.line, vscode.TreeItemCollapsibleState.None);
        item.description = `${element.id} | ${element.section}`;
        item.tooltip = `${element.section} (${element.id})\n${element.line}`;
        item.iconPath = themeIcon(taskIconId(element));
        item.id = `cortex.task.${element.projectName}.${element.id}`;
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.description;
        item.iconPath = themeIcon(element.iconId ?? "info");
        return item;
      }
    }
  }

  private async getProjectNodes(): Promise<CortexNode[]> {
    try {
      const projects = await this.fetchProjects();
      if (projects.length === 0) {
        return [{ kind: "message", label: "No projects found", description: "Index projects to populate Cortex.", iconId: "info" }];
      }
      return projects.map((project) => ({
        kind: "project",
        projectName: project.name,
        brief: project.brief,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load projects", error)];
    }
  }

  private async getFindingNodes(projectName: string): Promise<CortexNode[]> {
    try {
      const findings = await this.fetchFindings(projectName);
      if (findings.length === 0) {
        return [{ kind: "message", label: "No findings", iconId: "list-flat" }];
      }
      return findings.map((finding) => ({
        kind: "finding",
        projectName,
        id: finding.id,
        date: finding.date,
        text: finding.text,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load findings", error)];
    }
  }

  private async getBacklogNodes(projectName: string): Promise<CortexNode[]> {
    try {
      const tasks = await this.fetchTasks(projectName);
      if (tasks.length === 0) {
        return [{ kind: "message", label: "No backlog items", iconId: "checklist" }];
      }
      return tasks.map((task) => ({
        kind: "task",
        projectName,
        id: task.id,
        line: task.line,
        section: task.section,
        checked: task.checked,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load backlog", error)];
    }
  }

  private async fetchProjects(): Promise<ProjectSummary[]> {
    const raw = await this.client.listProjects();
    const data = responseData(raw);
    const projects = asArray(data?.projects);
    const parsed: ProjectSummary[] = [];

    for (const entry of projects) {
      const record = asRecord(entry);
      const name = asString(record?.name);
      if (!name) {
        continue;
      }

      const brief = asString(record?.brief);
      parsed.push(brief ? { name, brief } : { name });
    }

    return parsed;
  }

  private async fetchFindings(projectName: string): Promise<FindingSummary[]> {
    const raw = await this.client.getFindings(projectName);
    const data = responseData(raw);
    const findings = asArray(data?.findings);
    const parsed: FindingSummary[] = [];

    for (const entry of findings) {
      const record = asRecord(entry);
      const id = asString(record?.id);
      const text = asString(record?.text);
      if (!id || !text) {
        continue;
      }

      parsed.push({
        id,
        date: asString(record?.date) ?? "unknown",
        text,
      });
    }

    return parsed;
  }

  private async fetchTasks(projectName: string): Promise<TaskSummary[]> {
    const raw = await this.client.getTasks(projectName);
    const data = responseData(raw);
    const items = asRecord(data?.items);
    const sections: BacklogSection[] = ["Active", "Queue", "Done"];
    const tasks: TaskSummary[] = [];

    for (const section of sections) {
      const sectionItems = asArray(items?.[section]);
      for (const entry of sectionItems) {
        const record = asRecord(entry);
        const line = asString(record?.line);
        if (!line) {
          continue;
        }

        tasks.push({
          id: asString(record?.id) ?? `${section}-${tasks.length + 1}`,
          line,
          section,
          checked: asBoolean(record?.checked) ?? section === "Done",
        });
      }
    }

    return tasks;
  }

  private errorNode(label: string, error: unknown): MessageNode {
    const description = error instanceof Error ? error.message : String(error);
    return { kind: "message", label, description, iconId: "warning" };
  }
}

function categoryIconId(category: CortexCategory): string {
  if (category === "findings") {
    return "list-flat";
  }
  if (category === "backlog") {
    return "checklist";
  }
  return "book";
}

function taskIconId(task: TaskNode): string {
  if (task.checked || task.section === "Done") {
    return "check";
  }
  if (task.section === "Active") {
    return "play";
  }
  return "clock";
}

function truncate(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function responseData(value: unknown): Record<string, unknown> | undefined {
  const response = asRecord(value);
  return asRecord(response?.data);
}

function themeIcon(id: string): vscode.ThemeIcon {
  if (id === "folder") {
    return vscode.ThemeIcon.Folder;
  }
  if (id === "file") {
    return vscode.ThemeIcon.File;
  }
  return { id } as unknown as vscode.ThemeIcon;
}
