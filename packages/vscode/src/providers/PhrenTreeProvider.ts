import * as vscode from "vscode";
import { PhrenClient } from "../phrenClient";
import { TreeDataSource } from "./tree-data";
import { buildTreeItem } from "./tree-nodes";
import type { DateFilter, PhrenNode } from "./tree-types";

export type { DateFilter } from "./tree-types";

export class PhrenTreeProvider implements vscode.TreeDataProvider<PhrenNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<PhrenNode | undefined | null>();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private dateFilter: DateFilter | undefined;

  private readonly data: TreeDataSource;

  constructor(
    client: PhrenClient,
    storePath: string,
  ) {
    this.data = new TreeDataSource(client, storePath);
  }

  setDateFilter(filter: DateFilter | undefined): void {
    this.dateFilter = filter;
    this.data.clearCache();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getDateFilter(): DateFilter | undefined {
    return this.dateFilter;
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  refresh(): void {
    this.data.clearCache();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async getParent(element: PhrenNode): Promise<PhrenNode | undefined> {
    if (element.kind === "rootSection") return undefined;

    if (element.kind === "projectGroup" || element.kind === "storeGroup") {
      return { kind: "rootSection", section: "projects" };
    }

    if (element.kind === "project") {
      const stores = await this.data.fetchStores();
      const projects = await this.data.fetchProjects();
      const primaryStoreName = stores.find((s) => s.role === "primary")?.name ?? "personal";
      const storeNames = [...new Set(projects.map((p) => p.store ?? primaryStoreName))];
      if (storeNames.length > 1) {
        const proj = projects.find((p) => p.name === element.projectName);
        const storeName = proj?.store ?? primaryStoreName;
        return { kind: "storeGroup", storeName, role: "team", count: 0 };
      }
      const ctx = this.data.readDeviceContext();
      if (ctx.activeProjects.size === 0) return { kind: "rootSection", section: "projects" };
      return { kind: "projectGroup", group: ctx.activeProjects.has(element.projectName.toLowerCase()) ? "device" : "other", count: 0 };
    }

    if (element.kind === "category") {
      return { kind: "project", projectName: element.projectName };
    }

    if (element.kind === "findingDateGroup") {
      return { kind: "category", projectName: element.projectName, category: "findings" };
    }

    if (element.kind === "finding") {
      return { kind: "findingDateGroup", projectName: element.projectName, date: element.date, count: 0 };
    }

    if (element.kind === "taskSectionGroup") {
      return { kind: "category", projectName: element.projectName, category: "task" };
    }

    if (element.kind === "task") {
      return { kind: "taskSectionGroup", projectName: element.projectName, section: element.section, count: 0 };
    }

    return undefined;
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
      return this.data.getRootSections(this.lastHealthOk);
    }

    if (element.kind === "rootSection") {
      if (element.section === "projects") {
        return this.data.getProjectNodes();
      }
      if (element.section === "tasks") {
        return this.data.getGlobalTaskBoard();
      }
      if (element.section === "machines") {
        return this.data.getMachineNodes();
      }
      if (element.section === "review") {
        return this.data.getReviewProjectGroups();
      }
      if (element.section === "skills") {
        return this.data.getSkillGroupNodes();
      }
      if (element.section === "hooks") {
        return this.data.getHookNodes();
      }
      if (element.section === "manage") {
        return this.data.getManageNodes(this.lastHealthOk);
      }
      return [];
    }

    if (element.kind === "projectGroup") {
      return this.data.getProjectNodesForGroup(element.group);
    }

    if (element.kind === "storeGroup") {
      return this.data.getProjectNodesForStore(element.storeName);
    }

    if (element.kind === "project") {
      return [
        { kind: "category", projectName: element.projectName, category: "findings" },
        { kind: "category", projectName: element.projectName, category: "truths" },
        { kind: "category", projectName: element.projectName, category: "sessions" },
        { kind: "category", projectName: element.projectName, category: "task" },
        { kind: "category", projectName: element.projectName, category: "queue" },
        { kind: "category", projectName: element.projectName, category: "hooks" },
        { kind: "category", projectName: element.projectName, category: "reference" },
      ];
    }

    if (element.kind === "category") {
      if (element.category === "findings") {
        return this.data.getFindingDateGroups(element.projectName, this.dateFilter);
      }
      if (element.category === "truths") {
        return this.data.getTruthNodes(element.projectName);
      }
      if (element.category === "sessions") {
        return this.data.getSessionDateGroups(element.projectName);
      }
      if (element.category === "task") {
        return this.data.getTaskSectionGroups(element.projectName);
      }
      if (element.category === "queue") {
        return this.data.getQueueSectionGroups(element.projectName);
      }
      if (element.category === "hooks") {
        return this.data.getProjectHookNodes(element.projectName);
      }
      if (element.category === "reference") {
        return this.data.getReferenceNodes(element.projectName);
      }
      return [];
    }

    if (element.kind === "queueSectionGroup") {
      return this.data.getQueueItemsForSection(element.projectName, element.section);
    }

    if (element.kind === "aggregateQueueSectionGroup") {
      return this.data.getAggregateQueueItemsForSection(element.section);
    }

    if (element.kind === "reviewProjectGroup") {
      return this.data.getQueueSectionGroups(element.projectName);
    }

    if (element.kind === "sessionDateGroup") {
      return this.data.getSessionsForDate(element.projectName, element.date);
    }

    if (element.kind === "session") {
      return this.data.getSessionChildren(element);
    }

    if (element.kind === "sessionBucket") {
      return this.data.getSessionBucketChildren(element);
    }

    if (element.kind === "findingDateGroup") {
      return this.data.getFindingsForDate(element.projectName, element.date, this.dateFilter);
    }

    if (element.kind === "globalTaskSectionGroup") {
      return this.data.getGlobalTasksForSection(element.section);
    }

    if (element.kind === "taskSectionGroup") {
      return this.data.getTasksForSection(element.projectName, element.section);
    }

    if (element.kind === "skillGroup") {
      return this.data.getSkillsForGroup(element.source);
    }

    return [];
  }

  getTreeItem(element: PhrenNode): vscode.TreeItem {
    try {
      return buildTreeItem(element, this.dateFilter);
    } catch (error) {
      console.error(`[phren-tree] getTreeItem crash:`, error, `element:`, JSON.stringify(element));
      const item = new vscode.TreeItem(`(error: ${error instanceof Error ? error.message : String(error)})`, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("warning");
      return item;
    }
  }

  /** Updated by the status bar health check; controls the Health row value. */
  private lastHealthOk: boolean | undefined;

  setHealthStatus(ok: boolean): void {
    if (this.lastHealthOk === ok) return;
    this.lastHealthOk = ok;
    this.data.clearCache();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }
}
