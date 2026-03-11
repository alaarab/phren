import * as vscode from "vscode";
import { CortexClient } from "../cortexClient";

type TaskSection = "Active" | "Queue" | "Done";
type CortexCategory = "findings" | "task" | "reference";

interface RootSectionNode {
  kind: "rootSection";
  section: "projects" | "skills" | "hooks" | "graph";
}

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
  section: TaskSection;
  checked: boolean;
}

interface SkillGroupNode {
  kind: "skillGroup";
  source: string;
}

interface SkillNode {
  kind: "skill";
  name: string;
  source: string;
  enabled: boolean;
  path?: string;
}

interface HookNode {
  kind: "hook";
  tool: string;
  enabled: boolean;
}

interface ReferenceFileNode {
  kind: "referenceFile";
  projectName: string;
  fileName: string;
}

interface MessageNode {
  kind: "message";
  label: string;
  description?: string;
  iconId?: string;
}

type CortexNode =
  | RootSectionNode
  | ProjectNode
  | CategoryNode
  | FindingNode
  | TaskNode
  | SkillGroupNode
  | SkillNode
  | HookNode
  | ReferenceFileNode
  | MessageNode;

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
  section: TaskSection;
  checked: boolean;
}

interface SkillSummary {
  name: string;
  source: string;
  enabled: boolean;
  path?: string;
}

export class CortexTreeProvider implements vscode.TreeDataProvider<CortexNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<CortexNode | undefined | null>();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly client: CortexClient) {}

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async getChildren(element?: CortexNode): Promise<CortexNode[]> {
    try {
      return await this.getChildrenInner(element);
    } catch (error) {
      console.error(`[cortex-tree] getChildren crash:`, error, `element:`, JSON.stringify(element));
      return [{ kind: "message", label: `Error: ${error instanceof Error ? error.message : String(error)}`, iconId: "warning" }];
    }
  }

  private async getChildrenInner(element?: CortexNode): Promise<CortexNode[]> {
    if (!element) {
      return [
        { kind: "rootSection", section: "projects" },
        { kind: "rootSection", section: "skills" },
        { kind: "rootSection", section: "hooks" },
        { kind: "rootSection", section: "graph" },
      ];
    }

    if (element.kind === "rootSection") {
      if (element.section === "projects") {
        return this.getProjectNodes();
      }
      if (element.section === "skills") {
        return this.getSkillGroupNodes();
      }
      if (element.section === "hooks") {
        return this.getHookNodes();
      }
      return [];
    }

    if (element.kind === "project") {
      return [
        { kind: "category", projectName: element.projectName, category: "findings" },
        { kind: "category", projectName: element.projectName, category: "task" },
        { kind: "category", projectName: element.projectName, category: "reference" },
      ];
    }

    if (element.kind === "category") {
      if (element.category === "findings") {
        return this.getFindingNodes(element.projectName);
      }
      if (element.category === "task") {
        return this.getTaskNodes(element.projectName);
      }
      if (element.category === "reference") {
        return this.getReferenceNodes(element.projectName);
      }
      return [];
    }

    if (element.kind === "skillGroup") {
      return this.getSkillsForGroup(element.source);
    }

    return [];
  }

  getTreeItem(element: CortexNode): vscode.TreeItem {
    try {
      return this.getTreeItemInner(element);
    } catch (error) {
      console.error(`[cortex-tree] getTreeItem crash:`, error, `element:`, JSON.stringify(element));
      const item = new vscode.TreeItem(`(error: ${error instanceof Error ? error.message : String(error)})`, vscode.TreeItemCollapsibleState.None);
      item.iconPath = themeIcon("warning");
      return item;
    }
  }

  private getTreeItemInner(element: CortexNode): vscode.TreeItem {
    if (!element || !element.kind) {
      return new vscode.TreeItem("(unknown)", vscode.TreeItemCollapsibleState.None);
    }
    switch (element.kind) {
      case "rootSection": {
        const labels: Record<string, string> = { projects: "Projects", skills: "Skills", hooks: "Hooks", graph: "Entity Graph" };
        const icons: Record<string, string> = { projects: "folder-library", skills: "extensions", hooks: "plug", graph: "type-hierarchy" };
        const label = labels[element.section] ?? element.section;

        if (element.section === "graph") {
          const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
          item.iconPath = themeIcon(icons[element.section]);
          item.id = `cortex.root.${element.section}`;
          item.command = { command: "cortex.showGraph", title: "Show Entity Graph" };
          item.tooltip = "Open the Cortex entity graph visualization";
          return item;
        }

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = themeIcon(icons[element.section] ?? "symbol-misc");
        item.id = `cortex.root.${element.section}`;
        return item;
      }
      case "project": {
        const item = new vscode.TreeItem(element.projectName, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = element.brief ? truncate(element.brief, 72) : undefined;
        item.iconPath = themeIcon("folder");
        item.id = `cortex.project.${element.projectName}`;
        return item;
      }
      case "category": {
        const cat = element.category ?? "unknown";
        const categoryLabel = cat.charAt(0).toUpperCase() + cat.slice(1);
        const item = new vscode.TreeItem(categoryLabel, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = themeIcon(categoryIconId(cat as CortexCategory));
        item.id = `cortex.category.${element.projectName}.${cat}`;
        return item;
      }
      case "finding": {
        const title = `${element.id} ${element.date}`;
        const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
        item.description = truncate(element.text, 96);
        item.tooltip = `${element.date}\n${element.text}`;
        item.iconPath = themeIcon("file");
        item.id = `cortex.finding.${element.projectName}.${element.id}`;
        item.command = {
          command: "cortex.openFinding",
          title: "Open Finding",
          arguments: [element],
        };
        return item;
      }
      case "task": {
        const sectionTag = element.section === "Done" ? "[Done]" : element.section === "Active" ? "[Active]" : "[Queue]";
        const item = new vscode.TreeItem(`${sectionTag} ${element.line}`, vscode.TreeItemCollapsibleState.None);
        item.description = element.id;
        item.tooltip = `${element.section} (${element.id})\n${element.line}`;
        item.iconPath = themeIcon(taskIconId(element));
        item.id = `cortex.task.${element.projectName}.${element.id}`;
        item.command = {
          command: "cortex.openTask",
          title: "Open Task",
          arguments: [element],
        };
        return item;
      }
      case "skillGroup": {
        const label = element.source.charAt(0).toUpperCase() + element.source.slice(1);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = themeIcon(element.source === "global" ? "globe" : "folder");
        item.id = `cortex.skillGroup.${element.source}`;
        return item;
      }
      case "skill": {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.description = element.enabled ? "enabled" : "disabled";
        item.tooltip = `${element.name} (${element.source})\n${element.enabled ? "Enabled" : "Disabled"}${element.path ? `\n${element.path}` : ""}`;
        item.iconPath = themeIcon(element.enabled ? "check" : "circle-slash");
        item.id = `cortex.skill.${element.source}.${element.name}`;
        item.contextValue = element.enabled ? "cortex.skill.enabled" : "cortex.skill.disabled";
        item.command = {
          command: "cortex.openSkill",
          title: "Open Skill",
          arguments: [element.name, element.source],
        };
        return item;
      }
      case "hook": {
        const item = new vscode.TreeItem(element.tool, vscode.TreeItemCollapsibleState.None);
        item.description = element.enabled ? "enabled" : "disabled";
        item.tooltip = `${element.tool}: ${element.enabled ? "hooks enabled" : "hooks disabled"}\nClick to toggle`;
        item.iconPath = themeIcon(element.enabled ? "check" : "circle-slash");
        item.id = `cortex.hook.${element.tool}`;
        item.contextValue = element.enabled ? "cortex.hook.enabled" : "cortex.hook.disabled";
        item.command = {
          command: "cortex.toggleHook",
          title: "Toggle Hook",
          arguments: [element.tool, element.enabled],
        };
        return item;
      }
      case "referenceFile": {
        const item = new vscode.TreeItem(element.fileName, vscode.TreeItemCollapsibleState.None);
        item.iconPath = themeIcon("file");
        item.id = `cortex.reference.${element.projectName}.${element.fileName}`;
        item.command = {
          command: "cortex.openProjectFile",
          title: "Open File",
          arguments: [element.projectName, `reference/${element.fileName}`],
        };
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

  // --- Data fetchers ---

  private async getProjectNodes(): Promise<CortexNode[]> {
    try {
      const projects = await this.fetchProjects();
      if (projects.length === 0) {
        return [{ kind: "message", label: "No projects found", description: "Index projects to populate Cortex.", iconId: "info" }];
      }
      return projects.map((project) => ({
        kind: "project" as const,
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
        kind: "finding" as const,
        projectName,
        id: finding.id,
        date: finding.date,
        text: finding.text,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load findings", error)];
    }
  }

  private async getTaskNodes(projectName: string): Promise<CortexNode[]> {
    try {
      const tasks = await this.fetchTasks(projectName);
      if (tasks.length === 0) {
        return [{ kind: "message", label: "No task items", iconId: "checklist" }];
      }
      return tasks.map((task) => ({
        kind: "task" as const,
        projectName,
        id: task.id,
        line: task.line,
        section: task.section,
        checked: task.checked,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load task", error)];
    }
  }

  private async getReferenceNodes(projectName: string): Promise<CortexNode[]> {
    try {
      const raw = await this.client.getProjectSummary(projectName);
      const data = responseData(raw);
      const files = asArray(data?.files);
      const refFiles: CortexNode[] = [];

      for (const entry of files) {
        const record = asRecord(entry);
        const name = asString(record?.name) ?? asString(record?.path) ?? (typeof entry === "string" ? entry : undefined);
        if (!name) {
          continue;
        }
        if (name.startsWith("reference/") || name.startsWith("reference\\")) {
          const fileName = name.replace(/^reference[/\\]/, "");
          if (fileName) {
            refFiles.push({ kind: "referenceFile", projectName, fileName });
          }
        }
      }

      if (refFiles.length === 0) {
        return [{ kind: "message", label: "No reference docs", iconId: "book" }];
      }
      return refFiles;
    } catch (error) {
      return [this.errorNode("Failed to load reference files", error)];
    }
  }

  private async getSkillGroupNodes(): Promise<CortexNode[]> {
    try {
      const skills = await this.fetchSkills();
      if (skills.length === 0) {
        return [{ kind: "message", label: "No skills installed", iconId: "extensions" }];
      }

      const sources = new Set<string>();
      for (const skill of skills) {
        sources.add(skill.source);
      }

      // Sort: global first, then alphabetical
      const sorted = [...sources].sort((a, b) => {
        if (a === "global") return -1;
        if (b === "global") return 1;
        return a.localeCompare(b);
      });

      return sorted.map((source) => ({ kind: "skillGroup" as const, source }));
    } catch (error) {
      return [this.errorNode("Failed to load skills", error)];
    }
  }

  private async getSkillsForGroup(source: string): Promise<CortexNode[]> {
    try {
      const skills = await this.fetchSkills();
      const filtered = skills.filter((s) => s.source === source);
      if (filtered.length === 0) {
        return [{ kind: "message", label: "No skills in this group", iconId: "extensions" }];
      }
      return filtered.map((skill) => ({
        kind: "skill" as const,
        name: skill.name,
        source: skill.source,
        enabled: skill.enabled,
        path: skill.path,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load skills", error)];
    }
  }

  private async getHookNodes(): Promise<CortexNode[]> {
    try {
      const raw = await this.client.listHooks();
      const data = responseData(raw);
      const tools = asArray(data?.tools);

      if (tools.length === 0) {
        return [{ kind: "message", label: "No hooks configured", iconId: "plug" }];
      }

      const nodes: CortexNode[] = [];
      for (const entry of tools) {
        const record = asRecord(entry);
        const tool = asString(record?.tool);
        if (!tool) { continue; }
        const enabled = asBoolean(record?.enabled) ?? false;
        nodes.push({ kind: "hook", tool, enabled });
      }

      return nodes;
    } catch (error) {
      return [this.errorNode("Failed to load hooks", error)];
    }
  }

  // --- Raw fetch helpers ---

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
    const sections: TaskSection[] = ["Active", "Queue", "Done"];
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

  private async fetchSkills(): Promise<SkillSummary[]> {
    const raw = await this.client.listSkills();
    const data = responseData(raw);
    const skills = asArray(data?.skills);
    const parsed: SkillSummary[] = [];

    for (const entry of skills) {
      const record = asRecord(entry);
      const name = asString(record?.name);
      const source = asString(record?.source);
      if (!name || !source) {
        continue;
      }

      parsed.push({
        name,
        source,
        enabled: asBoolean(record?.enabled) ?? true,
        path: asString(record?.path),
      });
    }

    return parsed;
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
  if (category === "task") {
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
  // ThemeIcon constructor may be private in some type def versions, but it exists at runtime
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (vscode.ThemeIcon as any)(id) as vscode.ThemeIcon;
}
