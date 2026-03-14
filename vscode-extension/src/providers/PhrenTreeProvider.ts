import * as vscode from "vscode";
import { PhrenClient } from "../phrenClient";
import { readDeviceContext } from "../profileConfig";

type TaskSection = "Active" | "Queue" | "Done";
type PhrenCategory = "findings" | "sessions" | "task" | "queue" | "reference";
type SessionBucket = "findings" | "tasks";

interface RootSectionNode {
  kind: "rootSection";
  section: "projects" | "machines" | "review" | "skills" | "hooks" | "graph" | "manage";
  description?: string;
}

interface ProjectGroupNode {
  kind: "projectGroup";
  group: "device" | "other";
  count: number;
}

interface ManageItemNode {
  kind: "manageItem";
  item: "health" | "profile" | "machine" | "lastSync";
  label: string;
  value: string;
}

interface ProjectNode {
  kind: "project";
  projectName: string;
  brief?: string;
}

interface CategoryNode {
  kind: "category";
  projectName: string;
  category: PhrenCategory;
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
  supersededBy?: string;
  supersedes?: string;
  contradicts?: string[];
  potentialDuplicates?: string[];
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

interface CustomHookNode {
  kind: "customHook";
  event: string;
  target: string;
  isWebhook: boolean;
  timeout?: number;
}

interface HookErrorNode {
  kind: "hookError";
  timestamp: string;
  event: string;
  message: string;
}

type QueueSection = "Review" | "Stale" | "Conflicts";

interface QueueSectionGroupNode {
  kind: "queueSectionGroup";
  projectName: string;
  section: QueueSection;
  count: number;
}

interface AggregateQueueSectionGroupNode {
  kind: "aggregateQueueSectionGroup";
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
  showProjectName?: boolean;
}

interface ReferenceFileNode {
  kind: "referenceFile";
  projectName: string;
  fileName: string;
}

interface SessionDateGroupNode {
  kind: "sessionDateGroup";
  projectName: string;
  date: string;
  count: number;
}

interface SessionNode {
  kind: "session";
  projectName: string;
  date: string;
  sessionId: string;
  startedAt: string;
  durationMins?: number;
  summary?: string;
  findingsAdded: number;
  status: "active" | "ended";
}

interface SessionBucketNode {
  kind: "sessionBucket";
  projectName: string;
  sessionId: string;
  bucket: SessionBucket;
  count: number;
}

interface MessageNode {
  kind: "message";
  label: string;
  description?: string;
  iconId?: string;
}

type PhrenNode =
  | RootSectionNode
  | ProjectGroupNode
  | ManageItemNode
  | ProjectNode
  | CategoryNode
  | FindingDateGroupNode
  | FindingNode
  | TaskSectionGroupNode
  | TaskNode
  | QueueSectionGroupNode
  | AggregateQueueSectionGroupNode
  | QueueItemNode
  | SkillGroupNode
  | SkillNode
  | HookNode
  | CustomHookNode
  | HookErrorNode
  | ReferenceFileNode
  | SessionDateGroupNode
  | SessionNode
  | SessionBucketNode
  | MessageNode;

interface ProjectSummary {
  name: string;
  brief?: string;
}

interface FindingSummary {
  id: string;
  date: string;
  text: string;
  supersededBy?: string;
  supersedes?: string;
  contradicts?: string[];
  potentialDuplicates?: string[];
}

interface TaskSummary {
  id: string;
  line: string;
  section: TaskSection;
  checked: boolean;
}

interface QueueItemSummary {
  projectName: string;
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

interface SessionSummary {
  projectName: string;
  date: string;
  sessionId: string;
  startedAt: string;
  durationMins?: number;
  summary?: string;
  findingsAdded: number;
  status: "active" | "ended";
}

interface SessionArtifactSummary {
  findings: FindingSummary[];
  tasks: TaskSummary[];
}

export interface DateFilter {
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  label: string;
}

export class PhrenTreeProvider implements vscode.TreeDataProvider<PhrenNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<PhrenNode | undefined | null>();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private dateFilter: DateFilter | undefined;

  constructor(
    private readonly client: PhrenClient,
    private readonly storePath: string,
  ) {}

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

  async getChildren(element?: PhrenNode): Promise<PhrenNode[]> {
    try {
      return await this.getChildrenInner(element);
    } catch (error) {
      console.error(`[phren-tree] getChildren crash:`, error, `element:`, JSON.stringify(element));
      return [{ kind: "message", label: `Error: ${error instanceof Error ? error.message : String(error)}`, iconId: "warning" }];
    }
  }

  private async getChildrenInner(element?: PhrenNode): Promise<PhrenNode[]> {
    if (!element) {
      return this.getRootSections();
    }

    if (element.kind === "rootSection") {
      if (element.section === "projects") {
        return this.getProjectNodes();
      }
      if (element.section === "machines") {
        return this.getMachineNodes();
      }
      if (element.section === "review") {
        return this.getAggregateQueueSectionGroups();
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
        { kind: "category", projectName: element.projectName, category: "sessions" },
        { kind: "category", projectName: element.projectName, category: "task" },
        { kind: "category", projectName: element.projectName, category: "queue" },
        { kind: "category", projectName: element.projectName, category: "reference" },
      ];
    }

    if (element.kind === "category") {
      if (element.category === "findings") {
        return this.getFindingDateGroups(element.projectName);
      }
      if (element.category === "sessions") {
        return this.getSessionDateGroups(element.projectName);
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

    if (element.kind === "aggregateQueueSectionGroup") {
      return this.getAggregateQueueItemsForSection(element.section);
    }

    if (element.kind === "sessionDateGroup") {
      return this.getSessionsForDate(element.projectName, element.date);
    }

    if (element.kind === "session") {
      return this.getSessionChildren(element);
    }

    if (element.kind === "sessionBucket") {
      return this.getSessionBucketChildren(element);
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

    return [];
  }

  getTreeItem(element: PhrenNode): vscode.TreeItem {
    try {
      return this.getTreeItemInner(element);
    } catch (error) {
      console.error(`[phren-tree] getTreeItem crash:`, error, `element:`, JSON.stringify(element));
      const item = new vscode.TreeItem(`(error: ${error instanceof Error ? error.message : String(error)})`, vscode.TreeItemCollapsibleState.None);
      item.iconPath = themeIcon("warning");
      return item;
    }
  }

  private getTreeItemInner(element: PhrenNode): vscode.TreeItem {
    if (!element || !element.kind) {
      return new vscode.TreeItem("(unknown)", vscode.TreeItemCollapsibleState.None);
    }
    switch (element.kind) {
      case "rootSection": {
        const labels: Record<string, string> = { projects: "Projects", machines: "Machines", review: "Review Queue", skills: "Skills", hooks: "Hooks", graph: "Fragment Graph", manage: "Manage" };
        const icons: Record<string, string> = { projects: "hubot", machines: "vm", review: "inbox", skills: "extensions", hooks: "plug", graph: "type-hierarchy", manage: "gear" };
        const label = labels[element.section] ?? element.section;

        if (element.section === "graph") {
          const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
          item.iconPath = themeIcon(icons[element.section]);
          item.id = `phren.root.${element.section}`;
          item.command = { command: "phren.showGraph", title: "Show Fragment Graph" };
          item.tooltip = "Open the Phren fragment graph visualization";
          return item;
        }

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = element.description;
        item.iconPath = themeIcon(icons[element.section] ?? "symbol-misc");
        item.id = `phren.root.${element.section}`;
        return item;
      }
      case "project": {
        const item = new vscode.TreeItem(element.projectName, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = element.brief ? truncate(element.brief, 72) : undefined;
        item.iconPath = themeIcon("folder");
        item.id = `phren.project.${element.projectName}`;
        return item;
      }
      case "category": {
        const cat = element.category ?? "unknown";
        const categoryLabels: Record<string, string> = { findings: "Findings", sessions: "Sessions", task: "Tasks", queue: "Review Queue", reference: "Reference" };
        let categoryLabel = categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1);
        if (cat === "findings" && this.dateFilter) {
          categoryLabel += ` [${this.dateFilter.label}]`;
        }
        const item = new vscode.TreeItem(categoryLabel, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = themeIcon(categoryIconId(cat as PhrenCategory));
        item.id = `phren.category.${element.projectName}.${cat}`;
        if (cat === "findings") {
          item.contextValue = "phren.category.findings";
        }
        return item;
      }
      case "findingDateGroup": {
        const label = formatDateLabel(element.date);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${element.count}`;
        item.iconPath = themeIcon("calendar");
        item.id = `phren.findingDateGroup.${element.projectName}.${element.date}`;
        return item;
      }
      case "sessionDateGroup": {
        const label = formatDateLabel(element.date);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${element.count}`;
        item.iconPath = themeIcon("calendar");
        item.id = `phren.sessionDateGroup.${element.projectName}.${element.date}`;
        return item;
      }
      case "finding": {
        const item = new vscode.TreeItem(truncate(element.text, 120), vscode.TreeItemCollapsibleState.None);
        const tooltipLines = [element.text];
        let iconId = "lightbulb";
        if (element.supersededBy) {
          iconId = "lightbulb-autofix";
          tooltipLines.push(`Superseded by: "${element.supersededBy}"`);
        } else if (element.contradicts?.length) {
          iconId = "warning";
          tooltipLines.push(`Contradicts: "${element.contradicts[0]}"`);
        } else if (element.potentialDuplicates?.length) {
          iconId = "issue-opened";
          tooltipLines.push(`Potential duplicate of: "${element.potentialDuplicates[0]}"`);
          if (element.potentialDuplicates.length > 1) {
            tooltipLines.push(`(and ${element.potentialDuplicates.length - 1} more)`);
          }
        }
        if (element.supersedes) {
          tooltipLines.push(`Supersedes: "${element.supersedes}"`);
        }
        item.tooltip = tooltipLines.join("\n");
        item.iconPath = themeIcon(iconId);
        item.id = `phren.finding.${element.projectName}.${element.id}`;
        item.contextValue = "phren.finding";
        if (element.supersededBy) {
          item.description = "(superseded)";
        } else if (element.contradicts?.length) {
          item.description = "(conflict)";
        } else if (element.potentialDuplicates?.length) {
          item.description = "(possible duplicate)";
        }
        item.command = {
          command: "phren.openFinding",
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
        item.id = `phren.taskSectionGroup.${element.projectName}.${element.section}`;
        return item;
      }
      case "task": {
        const item = new vscode.TreeItem(truncate(element.line, 120), vscode.TreeItemCollapsibleState.None);
        item.tooltip = `${element.section} (${element.id})\n${element.line}`;
        item.iconPath = themeIcon(taskIconId(element));
        item.id = `phren.task.${element.projectName}.${element.id}`;
        item.contextValue = element.section !== "Done" ? "phren.task.active" : "phren.task.done";
        item.command = {
          command: "phren.openTask",
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
        item.id = `phren.queueSectionGroup.${element.projectName}.${element.section}`;
        return item;
      }
      case "aggregateQueueSectionGroup": {
        const queueIcons: Record<string, string> = { Review: "inbox", Stale: "history", Conflicts: "warning" };
        const item = new vscode.TreeItem(element.section, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${element.count}`;
        item.iconPath = themeIcon(queueIcons[element.section] ?? "list-flat");
        item.id = `phren.aggregateQueueSectionGroup.${element.section}`;
        return item;
      }
      case "queueItem": {
        const item = new vscode.TreeItem(truncate(element.text, 120), vscode.TreeItemCollapsibleState.None);
        const confLabel = element.confidence !== undefined ? ` (${Math.round(element.confidence * 100)}%)` : "";
        item.tooltip = `${element.section} ${element.id}${confLabel}\n${element.date}\n${element.text}`;
        item.iconPath = themeIcon(element.risky ? "warning" : "mail");
        item.id = `phren.queueItem.${element.projectName}.${element.id}`;
        item.description = element.showProjectName ? element.projectName : undefined;
        item.contextValue = "phren.queue.item";
        item.command = {
          command: "phren.openQueueItem",
          title: "Open Queue Item",
          arguments: [element],
        };
        return item;
      }
      case "skillGroup": {
        const label = element.source.charAt(0).toUpperCase() + element.source.slice(1);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = themeIcon(element.source === "global" ? "globe" : "folder");
        item.id = `phren.skillGroup.${element.source}`;
        return item;
      }
      case "skill": {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        item.description = element.enabled ? "enabled" : "disabled";
        item.tooltip = `${element.name} (${element.source})\n${element.enabled ? "Enabled" : "Disabled"}${element.path ? `\n${element.path}` : ""}`;
        item.iconPath = themeIcon(element.enabled ? "check" : "circle-slash");
        item.id = `phren.skill.${element.source}.${element.name}`;
        item.contextValue = element.enabled ? "phren.skill.enabled" : "phren.skill.disabled";
        item.command = {
          command: "phren.openSkill",
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
        item.id = `phren.hook.${element.tool}`;
        item.contextValue = "phren.hookItem";
        item.command = {
          command: "phren.toggleHook",
          title: "Toggle Hook",
          arguments: [element.tool, element.enabled],
        };
        return item;
      }
      case "customHook": {
        const item = new vscode.TreeItem(element.event, vscode.TreeItemCollapsibleState.None);
        const prefix = element.isWebhook ? "[webhook] " : "";
        item.description = `${prefix}${element.target}`;
        item.tooltip = `Custom hook: ${element.event}\n${prefix}${element.target}${element.timeout ? `\nTimeout: ${element.timeout}ms` : ""}`;
        item.iconPath = themeIcon("zap");
        item.id = `phren.customHook.${element.event}.${element.target.slice(0, 20)}`;
        item.contextValue = "phren.customHookItem";
        return item;
      }
      case "hookError": {
        const item = new vscode.TreeItem(element.event, vscode.TreeItemCollapsibleState.None);
        const ts = element.timestamp.slice(0, 19).replace("T", " ");
        item.description = `${ts} - ${element.message.slice(0, 60)}`;
        item.tooltip = `${element.timestamp}\n${element.event}: ${element.message}`;
        item.iconPath = themeIcon("warning");
        item.id = `phren.hookError.${element.timestamp}`;
        item.contextValue = "phren.hookErrorItem";
        return item;
      }
      case "referenceFile": {
        const item = new vscode.TreeItem(element.fileName, vscode.TreeItemCollapsibleState.None);
        item.iconPath = themeIcon("file");
        item.id = `phren.reference.${element.projectName}.${element.fileName}`;
        item.command = {
          command: "phren.openProjectFile",
          title: "Open File",
          arguments: [element.projectName, `reference/${element.fileName}`],
        };
        return item;
      }
      case "session": {
        const item = new vscode.TreeItem(formatSessionTimeLabel(element.startedAt), vscode.TreeItemCollapsibleState.Collapsed);
        const descriptionParts = [`${element.durationMins ?? 0}m`];
        if (element.findingsAdded > 0) {
          descriptionParts.push(`${element.findingsAdded}f`);
        }
        if (element.status === "active") {
          descriptionParts.push("active");
        }
        if (element.summary) {
          descriptionParts.push(truncate(element.summary, 40));
        }
        item.description = descriptionParts.join(" · ");
        item.tooltip = [
          `Session ${element.sessionId.slice(0, 8)}`,
          `Project: ${element.projectName}`,
          `Started: ${element.startedAt}`,
          `Duration: ~${element.durationMins ?? 0} min`,
          `Findings added: ${element.findingsAdded}`,
          `Status: ${element.status}`,
          ...(element.summary ? [`Summary: ${element.summary}`] : []),
        ].join("\n");
        item.iconPath = themeIcon(element.status === "active" ? "play-circle" : "history");
        item.id = `phren.session.${element.sessionId}`;
        item.contextValue = "phren.session";
        return item;
      }
      case "sessionBucket": {
        const labels: Record<SessionBucket, string> = { findings: "Findings", tasks: "Tasks" };
        const icons: Record<SessionBucket, string> = { findings: "list-flat", tasks: "checklist" };
        const item = new vscode.TreeItem(labels[element.bucket], vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${element.count}`;
        item.iconPath = themeIcon(icons[element.bucket]);
        item.id = `phren.sessionBucket.${element.projectName}.${element.sessionId}.${element.bucket}`;
        return item;
      }
      case "projectGroup": {
        const groupLabels: Record<string, string> = { device: "This Device", other: "Other Machines" };
        const groupIcons: Record<string, string> = { device: "vm", other: "globe" };
        const item = new vscode.TreeItem(groupLabels[element.group] ?? element.group, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${element.count}`;
        item.iconPath = themeIcon(groupIcons[element.group] ?? "folder");
        item.id = `phren.projectGroup.${element.group}`;
        return item;
      }
      case "manageItem": {
        const manageIcons: Record<string, string> = { health: "heart", profile: "vm", machine: "server", lastSync: "cloud" };
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.value;
        item.iconPath = themeIcon(manageIcons[element.item] ?? "info");
        item.id = `phren.manage.${element.item}`;
        if (element.item === "health") {
          item.command = { command: "phren.doctor", title: "Run Doctor" };
          item.tooltip = "Click to run Phren Doctor";
        } else if (element.item === "machine") {
          item.command = { command: "phren.configureMachine", title: "Set Machine Alias" };
          item.tooltip = "Click to change this machine alias";
        } else if (element.item === "profile") {
          item.command = { command: "phren.switchProfile", title: "Configure Profile" };
          item.tooltip = "Click to change this machine's profile mapping";
        } else if (element.item === "lastSync") {
          item.command = { command: "phren.sync", title: "Sync Now" };
          item.tooltip = "Click to sync Phren";
        }
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

  private async getRootSections(): Promise<PhrenNode[]> {
    const nodes: PhrenNode[] = [];
    nodes.push({ kind: "rootSection", section: "projects" });
    nodes.push({ kind: "rootSection", section: "machines" });
    nodes.push({ kind: "rootSection", section: "review" });
    nodes.push({ kind: "rootSection", section: "skills" });
    nodes.push({ kind: "rootSection", section: "hooks", description: await this.getHookSectionDescription() });
    nodes.push({ kind: "rootSection", section: "graph" });
    nodes.push({ kind: "rootSection", section: "manage" });
    return nodes;
  }

  private async getHookSectionDescription(): Promise<string | undefined> {
    try {
      const raw = await this.client.listHooks();
      const data = responseData(raw);
      const tools = asArray(data?.tools);
      const globalEnabled = asBoolean(data?.globalEnabled) ?? true;

      if (!globalEnabled) {
        return "off";
      }
      if (tools.length === 0) {
        return "none";
      }

      let enabledCount = 0;
      for (const entry of tools) {
        const record = asRecord(entry);
        if ((asBoolean(record?.enabled) ?? false) === true) {
          enabledCount += 1;
        }
      }
      return `${enabledCount}/${tools.length} on`;
    } catch {
      return undefined;
    }
  }

  private async getFindingDateGroups(projectName: string): Promise<PhrenNode[]> {
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

  private async getFindingsForDate(projectName: string, date: string): Promise<PhrenNode[]> {
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
          supersededBy: finding.supersededBy,
          supersedes: finding.supersedes,
          contradicts: finding.contradicts,
          potentialDuplicates: finding.potentialDuplicates,
        }));
    } catch (error) {
      return [this.errorNode("Failed to load findings", error)];
    }
  }

  private async getTaskSectionGroups(projectName: string): Promise<PhrenNode[]> {
    try {
      const tasks = await this.fetchTasks(projectName);
      if (tasks.length === 0) {
        return [{ kind: "message", label: "No task items", iconId: "checklist" }];
      }

      const sections: TaskSection[] = ["Active", "Queue", "Done"];
      const groups: PhrenNode[] = [];
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

  private async getTasksForSection(projectName: string, section: TaskSection): Promise<PhrenNode[]> {
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

  private async getQueueSectionGroups(projectName: string): Promise<PhrenNode[]> {
    try {
      const items = await this.fetchQueueItems(projectName);
      if (items.length === 0) {
        return [{ kind: "message", label: "No items in review queue", iconId: "inbox" }];
      }

      const sections: QueueSection[] = ["Review", "Stale", "Conflicts"];
      const groups: PhrenNode[] = [];
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

  private async getQueueItemsForSection(projectName: string, section: QueueSection): Promise<PhrenNode[]> {
    try {
      const items = await this.fetchQueueItems(projectName);
      return items
        .filter((i) => i.section === section)
        .map((item) => ({
          kind: "queueItem" as const,
          projectName: item.projectName,
          id: item.id,
          section: item.section,
          date: item.date,
          text: item.text,
          line: item.line,
          confidence: item.confidence,
          risky: item.risky,
          machine: item.machine,
          model: item.model,
          showProjectName: false,
        }));
    } catch (error) {
      return [this.errorNode("Failed to load queue items", error)];
    }
  }

  private async getAggregateQueueSectionGroups(): Promise<PhrenNode[]> {
    try {
      const items = await this.fetchQueueItems();
      if (items.length === 0) {
        return [{ kind: "message", label: "No items in review queue", iconId: "inbox" }];
      }

      const sections: QueueSection[] = ["Review", "Stale", "Conflicts"];
      return sections
        .map((section) => ({
          kind: "aggregateQueueSectionGroup" as const,
          section,
          count: items.filter((item) => item.section === section).length,
        }))
        .filter((group) => group.count > 0);
    } catch (error) {
      return [this.errorNode("Failed to load review queue", error)];
    }
  }

  private async getAggregateQueueItemsForSection(section: QueueSection): Promise<PhrenNode[]> {
    try {
      const items = await this.fetchQueueItems();
      return items
        .filter((item) => item.section === section)
        .map((item) => ({
          kind: "queueItem" as const,
          projectName: item.projectName,
          id: item.id,
          section: item.section,
          date: item.date,
          text: item.text,
          line: item.line,
          confidence: item.confidence,
          risky: item.risky,
          machine: item.machine,
          model: item.model,
          showProjectName: true,
        }));
    } catch (error) {
      return [this.errorNode("Failed to load queue items", error)];
    }
  }

  private async getSessionDateGroups(projectName: string): Promise<PhrenNode[]> {
    try {
      const sessions = await this.fetchSessions(projectName);
      if (sessions.length === 0) {
        return [{ kind: "message", label: "No sessions found", iconId: "history" }];
      }

      const dateOrder: string[] = [];
      const byDate = new Map<string, number>();
      for (const session of sessions) {
        const date = session.date || "unknown";
        if (!byDate.has(date)) {
          dateOrder.push(date);
          byDate.set(date, 0);
        }
        byDate.set(date, (byDate.get(date) ?? 0) + 1);
      }

      return dateOrder.map((date) => ({
        kind: "sessionDateGroup" as const,
        projectName,
        date,
        count: byDate.get(date) ?? 0,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load sessions", error)];
    }
  }

  private async getSessionsForDate(projectName: string, date: string): Promise<PhrenNode[]> {
    try {
      const sessions = await this.fetchSessions(projectName);
      return sessions
        .filter((session) => session.date === date)
        .map((session) => ({
          kind: "session" as const,
          projectName,
          date: session.date,
          sessionId: session.sessionId,
          startedAt: session.startedAt,
          durationMins: session.durationMins,
          summary: session.summary,
          findingsAdded: session.findingsAdded,
          status: session.status,
        }));
    } catch (error) {
      return [this.errorNode("Failed to load sessions", error)];
    }
  }

  private async getSessionChildren(session: SessionNode): Promise<PhrenNode[]> {
    try {
      const artifacts = await this.fetchSessionArtifacts(session.projectName, session.sessionId);
      const children: PhrenNode[] = [];

      if (artifacts.findings.length > 0) {
        children.push({
          kind: "sessionBucket" as const,
          projectName: session.projectName,
          sessionId: session.sessionId,
          bucket: "findings",
          count: artifacts.findings.length,
        });
      }
      if (artifacts.tasks.length > 0) {
        children.push({
          kind: "sessionBucket" as const,
          projectName: session.projectName,
          sessionId: session.sessionId,
          bucket: "tasks",
          count: artifacts.tasks.length,
        });
      }

      if (children.length === 0) {
        return [{ kind: "message", label: "No findings or tasks captured", iconId: "history" }];
      }

      return children;
    } catch (error) {
      return [this.errorNode("Failed to load session details", error)];
    }
  }

  private async getSessionBucketChildren(bucket: SessionBucketNode): Promise<PhrenNode[]> {
    try {
      const artifacts = await this.fetchSessionArtifacts(bucket.projectName, bucket.sessionId);
      if (bucket.bucket === "findings") {
        if (artifacts.findings.length === 0) {
          return [{ kind: "message", label: "No findings", iconId: "list-flat" }];
        }
        return artifacts.findings.map((finding) => ({
          kind: "finding" as const,
          projectName: bucket.projectName,
          id: finding.id,
          date: finding.date,
          text: finding.text,
          supersededBy: finding.supersededBy,
          supersedes: finding.supersedes,
          contradicts: finding.contradicts,
          potentialDuplicates: finding.potentialDuplicates,
        }));
      }

      if (artifacts.tasks.length === 0) {
        return [{ kind: "message", label: "No tasks", iconId: "checklist" }];
      }
      return artifacts.tasks.map((task) => ({
        kind: "task" as const,
        projectName: bucket.projectName,
        id: task.id,
        line: task.line,
        section: task.section,
        checked: task.checked,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load session artifacts", error)];
    }
  }

  private async getReferenceNodes(projectName: string): Promise<PhrenNode[]> {
    try {
      const raw = await this.client.getProjectSummary(projectName);
      const data = responseData(raw);
      const files = asArray(data?.files);
      const refFiles: PhrenNode[] = [];

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

  private async getSkillGroupNodes(): Promise<PhrenNode[]> {
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

  private async getSkillsForGroup(source: string): Promise<PhrenNode[]> {
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

  private async getHookNodes(): Promise<PhrenNode[]> {
    try {
      const raw = await this.client.listHooks();
      const data = responseData(raw);
      const tools = asArray(data?.tools);

      if (tools.length === 0) {
        return [{ kind: "message", label: "No hooks configured", iconId: "plug" }];
      }

      const nodes: PhrenNode[] = [];
      for (const entry of tools) {
        const record = asRecord(entry);
        const tool = asString(record?.tool);
        if (!tool) { continue; }
        const enabled = asBoolean(record?.enabled) ?? false;
        nodes.push({ kind: "hook", tool, enabled });
      }

      // Custom hooks
      const customHooks = asArray(data?.customHooks);
      for (const entry of customHooks) {
        const record = asRecord(entry);
        if (!record) continue;
        const event = asString(record.event);
        if (!event) continue;
        const isWebhook = typeof record.webhook === "string";
        const target = asString(isWebhook ? record.webhook : record.command) ?? "";
        const timeout = typeof record.timeout === "number" ? record.timeout : undefined;
        nodes.push({ kind: "customHook", event, target, isWebhook, timeout });
      }

      // Hook errors summary
      try {
        const errRaw = await this.client.listHookErrors();
        const errData = responseData(errRaw);
        const errors = asArray(errData?.errors);
        if (errors.length > 0) {
          for (const err of errors.slice(-5)) {
            const rec = asRecord(err);
            if (!rec) continue;
            nodes.push({
              kind: "hookError",
              timestamp: asString(rec.timestamp) ?? "",
              event: asString(rec.event) ?? "",
              message: asString(rec.message) ?? "",
            });
          }
        }
      } catch {
        // Hook errors are optional; ignore failures
      }

      return nodes;
    } catch (error) {
      return [this.errorNode("Failed to load hooks", error)];
    }
  }

  private readDeviceContext(): { profile: string; activeProjects: Set<string>; machine: string; lastSync: string } {
    return readDeviceContext(this.storePath);
  }

  private async getProjectNodes(): Promise<PhrenNode[]> {
    try {
      const projects = await this.fetchProjects();
      if (projects.length === 0) {
        return [{ kind: "message", label: "No projects found", description: "Index projects to populate Phren.", iconId: "info" }];
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
      const groups: PhrenNode[] = [];
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

  private async getProjectNodesForGroup(group: "device" | "other"): Promise<PhrenNode[]> {
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

  private getManageNodes(): PhrenNode[] {
    const ctx = this.readDeviceContext();
    const nodes: PhrenNode[] = [];
    nodes.push({ kind: "manageItem", item: "health", label: "Health", value: this.lastHealthOk === true ? "ok" : this.lastHealthOk === false ? "issues" : "..." });
    nodes.push({ kind: "manageItem", item: "lastSync", label: "Sync", value: ctx.lastSync || "(never)" });
    return nodes;
  }

  private getMachineNodes(): PhrenNode[] {
    const ctx = this.readDeviceContext();
    const nodes: PhrenNode[] = [];
    nodes.push({ kind: "manageItem", item: "machine", label: "Machine", value: ctx.machine || "(unset)" });
    nodes.push({ kind: "manageItem", item: "profile", label: "Profile", value: `${ctx.machine} → ${ctx.profile || "none"}` });
    return nodes;
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

      const contradictsRaw = record?.contradicts;
      const contradicts = Array.isArray(contradictsRaw)
        ? contradictsRaw.filter((v): v is string => typeof v === "string")
        : undefined;
      const potentialDuplicatesRaw = record?.potentialDuplicates;
      const potentialDuplicates = Array.isArray(potentialDuplicatesRaw)
        ? potentialDuplicatesRaw.filter((v): v is string => typeof v === "string")
        : undefined;
      parsed.push({
        id,
        date: asString(record?.date) ?? "unknown",
        text,
        supersededBy: asString(record?.supersededBy),
        supersedes: asString(record?.supersedes),
        contradicts: contradicts?.length ? contradicts : undefined,
        potentialDuplicates: potentialDuplicates?.length ? potentialDuplicates : undefined,
      });
    }

    return parsed;
  }

  private async fetchTasks(projectName: string): Promise<TaskSummary[]> {
    const raw = await this.client.getTasks(projectName, { status: "all", done_limit: 50 });
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

  private async fetchQueueItems(projectName?: string): Promise<QueueItemSummary[]> {
    const raw = await this.client.getReviewQueue(projectName);
    const data = responseData(raw);
    const items = asArray(data?.items);
    const parsed: QueueItemSummary[] = [];

    for (const entry of items) {
      const record = asRecord(entry);
      const id = asString(record?.id);
      const text = asString(record?.text);
      const resolvedProjectName = asString(record?.project) ?? projectName;
      if (!id || !text || !resolvedProjectName) {
        continue;
      }

      const sectionRaw = asString(record?.section) ?? "Review";
      const section = (["Review", "Stale", "Conflicts"].includes(sectionRaw) ? sectionRaw : "Review") as QueueSection;

      parsed.push({
        projectName: resolvedProjectName,
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

  private async fetchSessions(projectName: string): Promise<SessionSummary[]> {
    const raw = await this.client.sessionHistory({ limit: 50, project: projectName });
    const response = asRecord(raw);
    const sessions = asArray(response?.data);
    const parsed: SessionSummary[] = [];

    for (const entry of sessions) {
      const record = asRecord(entry);
      const sessionId = asString(record?.sessionId);
      const startedAt = asString(record?.startedAt);
      const status = asSessionStatus(record?.status);
      if (!sessionId || !startedAt || !status) {
        continue;
      }

      parsed.push({
        projectName,
        date: startedAt.includes("T") ? startedAt.slice(0, 10) : "unknown",
        sessionId,
        startedAt,
        durationMins: asNumber(record?.durationMins),
        summary: asString(record?.summary),
        findingsAdded: asNumber(record?.findingsAdded) ?? 0,
        status,
      });
    }

    return parsed;
  }

  private async fetchSessionArtifacts(projectName: string, sessionId: string): Promise<SessionArtifactSummary> {
    const raw = await this.client.sessionHistory({ sessionId, project: projectName });
    const data = responseData(raw);
    const findingsRaw = asArray(data?.findings);
    const tasksRaw = asArray(data?.tasks);

    const findings: SessionArtifactSummary["findings"] = [];
    for (const entry of findingsRaw) {
      const record = asRecord(entry);
      const id = asString(record?.id);
      const date = asString(record?.date) ?? "unknown";
      const text = asString(record?.text);
      if (!id || !text) {
        continue;
      }
      findings.push({
        id,
        date,
        text,
        supersededBy: asString(record?.supersededBy),
        supersedes: asString(record?.supersedes),
        contradicts: asStringArray(record?.contradicts),
        potentialDuplicates: asStringArray(record?.potentialDuplicates),
      });
    }

    const tasks: SessionArtifactSummary["tasks"] = [];
    for (const entry of tasksRaw) {
      const record = asRecord(entry);
      const id = asString(record?.id);
      const line = asString(record?.text);
      const section = asTaskSection(record?.section);
      if (!id || !line || !section) {
        continue;
      }
      tasks.push({
        id,
        line,
        section,
        checked: asBoolean(record?.checked) ?? section === "Done",
      });
    }

    return { findings, tasks };
  }

  private errorNode(label: string, error: unknown): MessageNode {
    const description = error instanceof Error ? error.message : String(error);
    return { kind: "message", label, description, iconId: "warning" };
  }
}

function categoryIconId(category: PhrenCategory): string {
  if (category === "findings") {
    return "list-flat";
  }
  if (category === "sessions") {
    return "history";
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

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value.filter((entry): entry is string => typeof entry === "string");
  return parsed.length > 0 ? parsed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asTaskSection(value: unknown): TaskSection | undefined {
  return value === "Active" || value === "Queue" || value === "Done" ? value : undefined;
}

function asSessionStatus(value: unknown): "active" | "ended" | undefined {
  return value === "active" || value === "ended" ? value : undefined;
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

function formatSessionTimeLabel(startedAt: string): string {
  const parsed = new Date(startedAt);
  if (isNaN(parsed.getTime())) {
    return startedAt;
  }

  return parsed.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function themeIcon(id: string, color?: string): vscode.ThemeIcon {
  if (id === "folder") {
    return vscode.ThemeIcon.Folder;
  }
  if (id === "file") {
    return vscode.ThemeIcon.File;
  }
  if (color) {
    return new vscode.ThemeIcon(id, new vscode.ThemeColor(color));
  }
  return new vscode.ThemeIcon(id);
}
