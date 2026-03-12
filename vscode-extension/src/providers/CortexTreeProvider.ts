import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CortexClient } from "../cortexClient";

type TaskSection = "Active" | "Queue" | "Done";
type CortexCategory = "findings" | "task" | "queue" | "reference";

interface RootSectionNode {
  kind: "rootSection";
  section: "projects" | "skills" | "hooks" | "graph" | "manage";
}

interface ProjectGroupNode {
  kind: "projectGroup";
  group: "device" | "other";
  count: number;
}

interface ManageItemNode {
  kind: "manageItem";
  item: "health" | "profile" | "machine" | "lastSync" | "hooks";
  label: string;
  value: string;
}

interface ManageHookNode {
  kind: "manageHook";
  tool: string;
  enabled: boolean;
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

interface FindingDateGroupNode {
  kind: "findingDateGroup";
  projectName: string;
  date: string;
  count: number;
}

interface FindingNode {
  kind: "finding";
  projectName: string;
  id: string;
  date: string;
  text: string;
}

interface TaskSectionGroupNode {
  kind: "taskSectionGroup";
  projectName: string;
  section: TaskSection;
  count: number;
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

type QueueSection = "Review" | "Stale" | "Conflicts";

interface QueueSectionGroupNode {
  kind: "queueSectionGroup";
  projectName: string;
  section: QueueSection;
  count: number;
}

interface QueueItemNode {
  kind: "queueItem";
  projectName: string;
  id: string;
  section: string;
  date: string;
  text: string;
  line: string;
  confidence?: number;
  risky: boolean;
  machine?: string;
  model?: string;
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
  | ProjectGroupNode
  | ManageItemNode
  | ManageHookNode
  | ProjectNode
  | CategoryNode
  | FindingDateGroupNode
  | FindingNode
  | TaskSectionGroupNode
  | TaskNode
  | QueueSectionGroupNode
  | QueueItemNode
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

interface QueueItemSummary {
  id: string;
  section: QueueSection;
  date: string;
  text: string;
  line: string;
  confidence?: number;
  risky: boolean;
  machine?: string;
  model?: string;
}

interface SkillSummary {
  name: string;
  source: string;
  enabled: boolean;
  path?: string;
}

export interface DateFilter {
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  label: string;
}

export class CortexTreeProvider implements vscode.TreeDataProvider<CortexNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<CortexNode | undefined | null>();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private dateFilter: DateFilter | undefined;

  constructor(private readonly client: CortexClient) {}

  setDateFilter(filter: DateFilter | undefined): void {
    this.dateFilter = filter;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getDateFilter(): DateFilter | undefined {
    return this.dateFilter;
  }

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
        { kind: "rootSection", section: "manage" },
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
      if (element.section === "manage") {
        return this.getManageNodes();
      }
      return [];
    }

    if (element.kind === "projectGroup") {
      return this.getProjectNodesForGroup(element.group);
    }

    if (element.kind === "project") {
      return [
        { kind: "category", projectName: element.projectName, category: "findings" },
        { kind: "category", projectName: element.projectName, category: "task" },
        { kind: "category", projectName: element.projectName, category: "queue" },
        { kind: "category", projectName: element.projectName, category: "reference" },
      ];
    }

    if (element.kind === "category") {
      if (element.category === "findings") {
        return this.getFindingDateGroups(element.projectName);
      }
      if (element.category === "task") {
        return this.getTaskSectionGroups(element.projectName);
      }
      if (element.category === "queue") {
        return this.getQueueSectionGroups(element.projectName);
      }
      if (element.category === "reference") {
        return this.getReferenceNodes(element.projectName);
      }
      return [];
    }

    if (element.kind === "queueSectionGroup") {
      return this.getQueueItemsForSection(element.projectName, element.section);
    }

    if (element.kind === "findingDateGroup") {
      return this.getFindingsForDate(element.projectName, element.date);
    }

    if (element.kind === "taskSectionGroup") {
      return this.getTasksForSection(element.projectName, element.section);
    }

    if (element.kind === "skillGroup") {
      return this.getSkillsForGroup(element.source);
    }

    if (element.kind === "manageItem" && element.item === "hooks") {
      return this.getManageHookNodes();
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
        const labels: Record<string, string> = { projects: "Projects", skills: "Skills", hooks: "Hooks", graph: "Entity Graph", manage: "Manage" };
        const icons: Record<string, string> = { projects: "folder-library", skills: "extensions", hooks: "plug", graph: "type-hierarchy", manage: "gear" };
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
        const categoryLabels: Record<string, string> = { findings: "Findings", task: "Task", queue: "Review Queue", reference: "Reference" };
        let categoryLabel = categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1);
        if (cat === "findings" && this.dateFilter) {
          categoryLabel += ` [${this.dateFilter.label}]`;
        }
        const item = new vscode.TreeItem(categoryLabel, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = themeIcon(categoryIconId(cat as CortexCategory));
        item.id = `cortex.category.${element.projectName}.${cat}`;
        if (cat === "findings") {
          item.contextValue = "cortex.category.findings";
        }
        return item;
      }
      case "findingDateGroup": {
        const label = formatDateLabel(element.date);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${element.count}`;
        item.iconPath = themeIcon("calendar");
        item.id = `cortex.findingDateGroup.${element.projectName}.${element.date}`;
        return item;
      }
      case "finding": {
        const item = new vscode.TreeItem(truncate(element.text, 120), vscode.TreeItemCollapsibleState.None);
        item.tooltip = element.text;
        item.iconPath = themeIcon("lightbulb");
        item.id = `cortex.finding.${element.projectName}.${element.id}`;
        item.contextValue = "cortex.finding";
        item.command = {
          command: "cortex.openFinding",
          title: "Open Finding",
          arguments: [element],
        };
        return item;
      }
      case "taskSectionGroup": {
        const sectionIcons: Record<string, string> = { Active: "play", Queue: "clock", Done: "check" };
        const item = new vscode.TreeItem(element.section, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${element.count}`;
        item.iconPath = themeIcon(sectionIcons[element.section] ?? "list-flat");
        item.id = `cortex.taskSectionGroup.${element.projectName}.${element.section}`;
        return item;
      }
      case "task": {
        const item = new vscode.TreeItem(truncate(element.line, 120), vscode.TreeItemCollapsibleState.None);
        item.tooltip = `${element.section} (${element.id})\n${element.line}`;
        item.iconPath = themeIcon(taskIconId(element));
        item.id = `cortex.task.${element.projectName}.${element.id}`;
        item.contextValue = element.section !== "Done" ? "cortex.task.active" : "cortex.task.done";
        item.command = {
          command: "cortex.openTask",
          title: "Open Task",
          arguments: [element],
        };
        return item;
      }
      case "queueSectionGroup": {
        const queueIcons: Record<string, string> = { Review: "inbox", Stale: "history", Conflicts: "warning" };
        const item = new vscode.TreeItem(element.section, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${element.count}`;
        item.iconPath = themeIcon(queueIcons[element.section] ?? "list-flat");
        item.id = `cortex.queueSectionGroup.${element.projectName}.${element.section}`;
        return item;
      }
      case "queueItem": {
        const item = new vscode.TreeItem(truncate(element.text, 120), vscode.TreeItemCollapsibleState.None);
        const confLabel = element.confidence !== undefined ? ` (${Math.round(element.confidence * 100)}%)` : "";
        item.tooltip = `${element.section} ${element.id}${confLabel}\n${element.date}\n${element.text}`;
        item.iconPath = themeIcon(element.risky ? "warning" : "mail");
        item.id = `cortex.queueItem.${element.projectName}.${element.id}`;
        item.command = {
          command: "cortex.openQueueItem",
          title: "Open Queue Item",
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
      case "projectGroup": {
        const groupLabels: Record<string, string> = { device: "This Device", other: "Other" };
        const groupIcons: Record<string, string> = { device: "vm", other: "globe" };
        const item = new vscode.TreeItem(groupLabels[element.group] ?? element.group, vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${element.count}`;
        item.iconPath = themeIcon(groupIcons[element.group] ?? "folder");
        item.id = `cortex.projectGroup.${element.group}`;
        return item;
      }
      case "manageItem": {
        const manageIcons: Record<string, string> = { health: "heart", profile: "account", machine: "vm", lastSync: "cloud", hooks: "plug" };
        const isCollapsible = element.item === "hooks";
        const item = new vscode.TreeItem(element.label, isCollapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.description = element.value;
        item.iconPath = themeIcon(manageIcons[element.item] ?? "info");
        item.id = `cortex.manage.${element.item}`;
        if (element.item === "health") {
          item.command = { command: "cortex.doctor", title: "Run Doctor" };
          item.tooltip = "Click to run Cortex Doctor";
        } else if (element.item === "profile") {
          item.command = { command: "cortex.switchProfile", title: "Switch Profile" };
          item.tooltip = "Click to switch Cortex profile";
        } else if (element.item === "lastSync") {
          item.command = { command: "cortex.sync", title: "Sync Now" };
          item.tooltip = "Click to sync Cortex";
        }
        return item;
      }
      case "manageHook": {
        const item = new vscode.TreeItem(element.tool, vscode.TreeItemCollapsibleState.None);
        item.description = element.enabled ? "enabled" : "disabled";
        item.tooltip = `${element.tool}: ${element.enabled ? "hooks enabled" : "hooks disabled"}\nClick to toggle`;
        item.iconPath = themeIcon(element.enabled ? "check" : "circle-slash");
        item.id = `cortex.manageHook.${element.tool}`;
        item.contextValue = "cortex.hookItem";
        item.command = {
          command: "cortex.toggleHook",
          title: "Toggle Hook",
          arguments: [element.tool, element.enabled],
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

  private async getFindingDateGroups(projectName: string): Promise<CortexNode[]> {
    try {
      let findings = await this.fetchFindings(projectName);

      // Apply date filter if set
      if (this.dateFilter) {
        findings = findings.filter((f) => {
          if (f.date === "unknown") return false;
          if (this.dateFilter!.from && f.date < this.dateFilter!.from) return false;
          if (this.dateFilter!.to && f.date > this.dateFilter!.to) return false;
          return true;
        });
      }

      if (findings.length === 0) {
        const msg = this.dateFilter ? "No findings in date range" : "No findings";
        return [{ kind: "message", label: msg, iconId: "list-flat" }];
      }

      // Group by date, preserve order (most recent first)
      const dateOrder: string[] = [];
      const byDate = new Map<string, number>();
      for (const f of findings) {
        const d = f.date || "unknown";
        if (!byDate.has(d)) {
          dateOrder.push(d);
          byDate.set(d, 0);
        }
        byDate.set(d, (byDate.get(d) ?? 0) + 1);
      }

      return dateOrder.map((date) => ({
        kind: "findingDateGroup" as const,
        projectName,
        date,
        count: byDate.get(date) ?? 0,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load findings", error)];
    }
  }

  private async getFindingsForDate(projectName: string, date: string): Promise<CortexNode[]> {
    try {
      let findings = await this.fetchFindings(projectName);

      // Apply date filter if set
      if (this.dateFilter) {
        findings = findings.filter((f) => {
          if (f.date === "unknown") return false;
          if (this.dateFilter!.from && f.date < this.dateFilter!.from) return false;
          if (this.dateFilter!.to && f.date > this.dateFilter!.to) return false;
          return true;
        });
      }

      return findings
        .filter((f) => (f.date || "unknown") === date)
        .map((finding) => ({
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

  private async getTaskSectionGroups(projectName: string): Promise<CortexNode[]> {
    try {
      const tasks = await this.fetchTasks(projectName);
      if (tasks.length === 0) {
        return [{ kind: "message", label: "No task items", iconId: "checklist" }];
      }

      const sections: TaskSection[] = ["Active", "Queue", "Done"];
      const groups: CortexNode[] = [];
      for (const section of sections) {
        const count = tasks.filter((t) => t.section === section).length;
        if (count > 0) {
          groups.push({
            kind: "taskSectionGroup" as const,
            projectName,
            section,
            count,
          });
        }
      }

      return groups.length > 0 ? groups : [{ kind: "message", label: "No task items", iconId: "checklist" }];
    } catch (error) {
      return [this.errorNode("Failed to load task", error)];
    }
  }

  private async getTasksForSection(projectName: string, section: TaskSection): Promise<CortexNode[]> {
    try {
      const tasks = await this.fetchTasks(projectName);
      return tasks
        .filter((t) => t.section === section)
        .map((task) => ({
          kind: "task" as const,
          projectName,
          id: task.id,
          line: task.line,
          section: task.section,
          checked: task.checked,
        }));
    } catch (error) {
      return [this.errorNode("Failed to load tasks", error)];
    }
  }

  private async getQueueSectionGroups(projectName: string): Promise<CortexNode[]> {
    try {
      const items = await this.fetchQueueItems(projectName);
      if (items.length === 0) {
        return [{ kind: "message", label: "No items in review queue", iconId: "inbox" }];
      }

      const sections: QueueSection[] = ["Review", "Stale", "Conflicts"];
      const groups: CortexNode[] = [];
      for (const section of sections) {
        const count = items.filter((i) => i.section === section).length;
        if (count > 0) {
          groups.push({
            kind: "queueSectionGroup" as const,
            projectName,
            section,
            count,
          });
        }
      }

      return groups.length > 0 ? groups : [{ kind: "message", label: "No items in review queue", iconId: "inbox" }];
    } catch (error) {
      return [this.errorNode("Failed to load review queue", error)];
    }
  }

  private async getQueueItemsForSection(projectName: string, section: QueueSection): Promise<CortexNode[]> {
    try {
      const items = await this.fetchQueueItems(projectName);
      return items
        .filter((i) => i.section === section)
        .map((item) => ({
          kind: "queueItem" as const,
          projectName,
          id: item.id,
          section: item.section,
          date: item.date,
          text: item.text,
          line: item.line,
          confidence: item.confidence,
          risky: item.risky,
          machine: item.machine,
          model: item.model,
        }));
    } catch (error) {
      return [this.errorNode("Failed to load queue items", error)];
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

  private readDeviceContext(): { profile: string; activeProjects: Set<string>; machine: string; lastSync: string } {
    const result = { profile: "", activeProjects: new Set<string>(), machine: os.hostname(), lastSync: "" };
    try {
      const contextPath = path.join(os.homedir(), ".cortex-context.md");
      if (!fs.existsSync(contextPath)) return result;
      const content = fs.readFileSync(contextPath, "utf8");
      const profileMatch = content.match(/^Profile:\s*(.+)/m);
      if (profileMatch) result.profile = profileMatch[1].trim();
      const machineMatch = content.match(/^Machine:\s*(.+)/m);
      if (machineMatch) result.machine = machineMatch[1].trim();
      const activeMatch = content.match(/^Active projects?:\s*(.+)/mi);
      if (activeMatch) {
        for (const name of activeMatch[1].split(",").map((s) => s.trim()).filter(Boolean)) {
          result.activeProjects.add(name.toLowerCase());
        }
      }
      const syncMatch = content.match(/^Last synced?:\s*(.+)/mi);
      if (syncMatch) result.lastSync = syncMatch[1].trim();
    } catch {
      // Context file unavailable
    }
    return result;
  }

  private async getProjectNodes(): Promise<CortexNode[]> {
    try {
      const projects = await this.fetchProjects();
      if (projects.length === 0) {
        return [{ kind: "message", label: "No projects found", description: "Index projects to populate Cortex.", iconId: "info" }];
      }
      const ctx = this.readDeviceContext();
      if (ctx.activeProjects.size === 0) {
        // No device context -- show flat list
        return projects.map((project) => ({
          kind: "project" as const,
          projectName: project.name,
          brief: project.brief,
        }));
      }
      const deviceProjects = projects.filter((p) => ctx.activeProjects.has(p.name.toLowerCase()));
      const otherProjects = projects.filter((p) => !ctx.activeProjects.has(p.name.toLowerCase()));
      const groups: CortexNode[] = [];
      if (deviceProjects.length > 0) {
        groups.push({ kind: "projectGroup", group: "device", count: deviceProjects.length });
      }
      if (otherProjects.length > 0) {
        groups.push({ kind: "projectGroup", group: "other", count: otherProjects.length });
      }
      return groups;
    } catch (error) {
      return [this.errorNode("Failed to load projects", error)];
    }
  }

  private async getProjectNodesForGroup(group: "device" | "other"): Promise<CortexNode[]> {
    try {
      const projects = await this.fetchProjects();
      const ctx = this.readDeviceContext();
      const filtered = group === "device"
        ? projects.filter((p) => ctx.activeProjects.has(p.name.toLowerCase()))
        : projects.filter((p) => !ctx.activeProjects.has(p.name.toLowerCase()));
      return filtered.map((project) => ({
        kind: "project" as const,
        projectName: project.name,
        brief: project.brief,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load projects", error)];
    }
  }

  private getManageNodes(): CortexNode[] {
    const ctx = this.readDeviceContext();
    const nodes: CortexNode[] = [];
    nodes.push({ kind: "manageItem", item: "health", label: "Health", value: this.lastHealthOk === true ? "ok" : this.lastHealthOk === false ? "error" : "unknown" });
    nodes.push({ kind: "manageItem", item: "profile", label: "Profile", value: ctx.profile || "(none)" });
    nodes.push({ kind: "manageItem", item: "machine", label: "Machine", value: ctx.machine });
    nodes.push({ kind: "manageItem", item: "lastSync", label: "Last Sync", value: ctx.lastSync || "(never)" });
    nodes.push({ kind: "manageItem", item: "hooks", label: "Hooks", value: "" });
    return nodes;
  }

  private async getManageHookNodes(): Promise<CortexNode[]> {
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
        nodes.push({ kind: "manageHook", tool, enabled });
      }
      return nodes;
    } catch (error) {
      return [this.errorNode("Failed to load hooks", error)];
    }
  }

  /** Updated by the status bar health check; controls the Health row value. */
  private lastHealthOk: boolean | undefined;

  setHealthStatus(ok: boolean): void {
    if (this.lastHealthOk === ok) return;
    this.lastHealthOk = ok;
    this.onDidChangeTreeDataEmitter.fire(undefined);
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

  private async fetchQueueItems(projectName: string): Promise<QueueItemSummary[]> {
    const raw = await this.client.getReviewQueue(projectName);
    const data = responseData(raw);
    const items = asArray(data?.items);
    const parsed: QueueItemSummary[] = [];

    for (const entry of items) {
      const record = asRecord(entry);
      const id = asString(record?.id);
      const text = asString(record?.text);
      if (!id || !text) {
        continue;
      }

      const sectionRaw = asString(record?.section) ?? "Review";
      const section = (["Review", "Stale", "Conflicts"].includes(sectionRaw) ? sectionRaw : "Review") as QueueSection;

      parsed.push({
        id,
        section,
        date: asString(record?.date) ?? "unknown",
        text,
        line: asString(record?.line) ?? text,
        confidence: asNumber(record?.confidence),
        risky: asBoolean(record?.risky) ?? false,
        machine: asString(record?.machine),
        model: asString(record?.model),
      });
    }

    return parsed;
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
  if (category === "queue") {
    return "inbox";
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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function responseData(value: unknown): Record<string, unknown> | undefined {
  const response = asRecord(value);
  return asRecord(response?.data);
}

function formatDateLabel(dateStr: string): string {
  if (dateStr === "unknown") { return "Unknown date"; }
  const parsed = new Date(dateStr + "T00:00:00");
  if (isNaN(parsed.getTime())) { return dateStr; }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);

  if (diffDays === 0) { return "Today"; }
  if (diffDays === 1) { return "Yesterday"; }
  if (diffDays < 7) { return `${diffDays} days ago`; }

  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: parsed.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
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
