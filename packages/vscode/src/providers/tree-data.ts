import * as vscode from "vscode";
import { PhrenClient } from "../phrenClient";
import { baseName, samePath } from "../pathUtils";
import { readDeviceContext } from "../profileConfig";
import type {
  DateFilter,
  FindingSummary,
  NoteSummary,
  MessageNode,
  PhrenNode,
  ProjectNode,
  ProjectSummary,
  QueueItemSummary,
  QueueSection,
  ReviewProjectGroupNode,
  SessionArtifactSummary,
  SessionBucketNode,
  SessionNode,
  SessionSummary,
  SkillSummary,
} from "./tree-types";
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asSessionStatus,
  asString,
  asStringArray,
  formatRelativeTime,
  responseData,
} from "./tree-utils";

/**
 * get_truths answers a list that may be plain strings, `{ text }` objects, or
 * an array directly under `data` (the tool shape has changed before). Accept
 * every form and drop anything without usable text rather than showing blanks.
 */
export function parseTruths(raw: unknown): string[] {
  const response = asRecord(raw);
  const data = response?.data;
  const record = asRecord(data);
  const list = Array.isArray(data) ? data : asArray(record?.truths ?? record?.items);
  const texts: string[] = [];
  for (const entry of list) {
    const text = typeof entry === "string"
      ? entry
      : asString(asRecord(entry)?.text) ?? asString(asRecord(entry)?.truth);
    const trimmed = text?.trim();
    if (trimmed) texts.push(trimmed);
  }
  return texts;
}


export class TreeDataSource {
  private cache = new Map<string, unknown>();
  private cacheGeneration = 0;

  constructor(
    private readonly client: PhrenClient,
    private readonly storePath: string,
  ) {}

  clearCache(): void {
    this.cache.clear();
    this.cacheGeneration++;
  }

  getCacheGeneration(): number {
    return this.cacheGeneration;
  }

  // --- Root sections ---

  async getRootSections(lastHealthOk: boolean | undefined): Promise<PhrenNode[]> {
    const nodes: PhrenNode[] = [];
    nodes.push({ kind: "rootSection", section: "projects" });
    nodes.push({ kind: "rootSection", section: "skills" });
    nodes.push({ kind: "rootSection", section: "machines" });
    nodes.push({ kind: "rootSection", section: "review" });
    nodes.push({ kind: "rootSection", section: "hooks", description: await this.getHookSectionDescription() });
    nodes.push({ kind: "rootSection", section: "graph" });
    nodes.push({ kind: "rootSection", section: "manage" });
    return nodes;
  }

  private async getHookSectionDescription(): Promise<string | undefined> {
    try {
      const raw = await this.fetchHooks();
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

  // --- Findings ---

  async getFindingDateGroups(projectName: string, dateFilter: DateFilter | undefined): Promise<PhrenNode[]> {
    try {
      let findings = await this.fetchFindings(projectName);

      if (dateFilter) {
        findings = findings.filter((f) => {
          if (f.date === "unknown") return false;
          if (dateFilter.from && f.date < dateFilter.from) return false;
          if (dateFilter.to && f.date > dateFilter.to) return false;
          return true;
        });
      }

      if (findings.length === 0) {
        const msg = dateFilter ? "No findings in date range" : "No findings";
        return [{ kind: "message", label: msg, iconId: "list-flat" }];
      }

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

  async getFindingsForDate(projectName: string, date: string, dateFilter: DateFilter | undefined): Promise<PhrenNode[]> {
    try {
      let findings = await this.fetchFindings(projectName);

      if (dateFilter) {
        findings = findings.filter((f) => {
          if (f.date === "unknown") return false;
          if (dateFilter.from && f.date < dateFilter.from) return false;
          if (dateFilter.to && f.date > dateFilter.to) return false;
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
          type: finding.type,
          confidence: finding.confidence,
          supersededBy: finding.supersededBy,
          supersedes: finding.supersedes,
          contradicts: finding.contradicts,
          potentialDuplicates: finding.potentialDuplicates,
        }));
    } catch (error) {
      return [this.errorNode("Failed to load findings", error)];
    }
  }


  async getNoteDateGroups(projectName: string): Promise<PhrenNode[]> {
    try {
      const notes = await this.fetchNotes(projectName);
      if (notes.length === 0) return [{ kind: "message", label: "No notes yet", iconId: "note" }];
      const counts = new Map<string, number>();
      for (const note of notes) counts.set(note.date, (counts.get(note.date) ?? 0) + 1);
      return [...counts].map(([date, count]) => ({ kind: "noteDateGroup" as const, projectName, date, count }));
    } catch (error) {
      return [this.errorNode("Failed to load notes", error)];
    }
  }

  async getNotesForDate(projectName: string, date: string): Promise<PhrenNode[]> {
    try {
      const notes = await this.fetchNotes(projectName);
      return notes.filter((note) => note.date === date).map((note) => ({
        kind: "note" as const,
        projectName,
        id: note.id,
        date: note.date,
        time: note.time,
        text: note.text,
        promoted: note.promoted,
      }));
    } catch (error) {
      return [this.errorNode("Failed to load notes", error)];
    }
  }


  // --- Queue ---

  async getQueueSectionGroups(projectName: string): Promise<PhrenNode[]> {
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

  async getQueueItemsForSection(projectName: string, section: QueueSection): Promise<PhrenNode[]> {
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

  async getAggregateQueueSectionGroups(): Promise<PhrenNode[]> {
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

  async getAggregateQueueItemsForSection(section: QueueSection): Promise<PhrenNode[]> {
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

  async getReviewProjectGroups(): Promise<PhrenNode[]> {
    try {
      const items = await this.fetchQueueItems();
      if (items.length === 0) {
        return [{ kind: "message", label: "No items in review queue", iconId: "inbox" }];
      }

      const reviewCounts = new Map<string, number>();
      const conflictCounts = new Map<string, number>();
      for (const item of items) {
        const p = item.projectName;
        if (item.section === "Conflicts") {
          conflictCounts.set(p, (conflictCounts.get(p) ?? 0) + 1);
        } else {
          reviewCounts.set(p, (reviewCounts.get(p) ?? 0) + 1);
        }
      }

      const projects = new Set([...reviewCounts.keys(), ...conflictCounts.keys()]);
      const nodes: ReviewProjectGroupNode[] = [...projects].map((p) => ({
        kind: "reviewProjectGroup" as const,
        projectName: p,
        reviewCount: reviewCounts.get(p) ?? 0,
        conflictCount: conflictCounts.get(p) ?? 0,
      }));

      nodes.sort((a, b) => {
        if (b.conflictCount !== a.conflictCount) return b.conflictCount - a.conflictCount;
        return (b.reviewCount + b.conflictCount) - (a.reviewCount + a.conflictCount);
      });

      return nodes;
    } catch (error) {
      return [this.errorNode("Failed to load review queue", error)];
    }
  }

  // --- Sessions ---

  async getSessionDateGroups(projectName: string): Promise<PhrenNode[]> {
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

  async getSessionsForDate(projectName: string, date: string): Promise<PhrenNode[]> {
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

  async getSessionChildren(session: SessionNode): Promise<PhrenNode[]> {
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

      if (children.length === 0) {
        return [{ kind: "message", label: "No findings captured", iconId: "history" }];
      }

      return children;
    } catch (error) {
      return [this.errorNode("Failed to load session details", error)];
    }
  }

  async getSessionBucketChildren(bucket: SessionBucketNode): Promise<PhrenNode[]> {
    try {
      const artifacts = await this.fetchSessionArtifacts(bucket.projectName, bucket.sessionId);
        if (artifacts.findings.length === 0) {
          return [{ kind: "message", label: "No findings", iconId: "list-flat" }];
        }
        return artifacts.findings.map((finding) => ({
          kind: "finding" as const,
          projectName: bucket.projectName,
          id: finding.id,
          date: finding.date,
          text: finding.text,
          type: finding.type,
          confidence: finding.confidence,
          supersededBy: finding.supersededBy,
          supersedes: finding.supersedes,
          contradicts: finding.contradicts,
          potentialDuplicates: finding.potentialDuplicates,
        }));
    } catch (error) {
      return [this.errorNode("Failed to load session artifacts", error)];
    }
  }

  // --- Truths ---

  async getTruthNodes(projectName: string): Promise<PhrenNode[]> {
    try {
      const truths = await this.fetchTruths(projectName);
      if (truths.length === 0) {
        return [{ kind: "message", label: "No truths pinned", iconId: "pin" }];
      }
      return truths.map((text) => ({ kind: "truth" as const, projectName, text }));
    } catch (error) {
      return [this.errorNode("Failed to load truths", error)];
    }
  }

  // The category row shows its child count while collapsed, so the provider
  // asks for the count without expanding the category.
  async getTruthCount(projectName: string): Promise<number | undefined> {
    try {
      return (await this.fetchTruths(projectName)).length;
    } catch {
      return undefined;
    }
  }

  private fetchTruths(projectName: string): Promise<string[]> {
    return this.cachedFetch(`truths:${projectName}`, async () => {
      const raw = await this.client.getTruths(projectName);
      return parseTruths(raw);
    });
  }

  // --- Reference ---

  async getReferenceNodes(projectName: string): Promise<PhrenNode[]> {
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

  // --- Skills ---

  async getSkillGroupNodes(): Promise<PhrenNode[]> {
    try {
      const skills = await this.fetchSkills();
      if (skills.length === 0) {
        return [{ kind: "message", label: "No skills installed", iconId: "extensions" }];
      }

      const sources = new Set<string>();
      for (const skill of skills) {
        sources.add(skill.source);
      }

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

  async getSkillsForGroup(source: string): Promise<PhrenNode[]> {
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

  // --- Hooks ---

  async getHookNodes(): Promise<PhrenNode[]> {
    try {
      const raw = await this.fetchHooks();
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
        const errRaw = await this.fetchHookErrors();
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

  async getProjectHookNodes(projectName: string): Promise<PhrenNode[]> {
    try {
      const raw = await this.cachedFetch(`projectHooks:${projectName}`, () => this.client.listHooks(projectName));
      const data = responseData(raw);
      const projectHooks = asRecord(data?.projectHooks);
      if (!projectHooks) {
        return [{ kind: "message", label: "No hook overrides", iconId: "plug" }];
      }

      const events = asArray(projectHooks.events);
      if (events.length === 0) {
        return [{ kind: "message", label: "No hook events", iconId: "plug" }];
      }

      const nodes: PhrenNode[] = [];
      for (const entry of events) {
        const record = asRecord(entry);
        if (!record) continue;
        const event = asString(record.event);
        if (!event) continue;
        const enabled = asBoolean(record.enabled) ?? true;
        const configured = record.configured === null || record.configured === undefined ? null : (asBoolean(record.configured) ?? null);
        nodes.push({ kind: "projectHookEvent", projectName, event, enabled, configured });
      }
      return nodes;
    } catch (error) {
      return [this.errorNode("Failed to load project hooks", error)];
    }
  }

  // --- Projects ---

  readDeviceContext(): { profile: string; activeProjects: Set<string>; machine: string; lastSync: string } {
    return readDeviceContext(this.storePath);
  }

  detectActiveProject(projects: ProjectSummary[]): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return undefined;
    // Multi-root: any open folder can be the project, in folder order.
    for (const folder of workspaceFolders) {
      const cwdPath = folder.uri.fsPath;
      const cwdName = baseName(cwdPath).toLowerCase();

      for (const p of projects) {
        if (p.source && samePath(p.source, cwdPath)) return p.name;
      }
      for (const p of projects) {
        if (p.name.toLowerCase() === cwdName) return p.name;
      }
      for (const p of projects) {
        if (p.source && baseName(p.source).toLowerCase() === cwdName) return p.name;
      }
    }
    return undefined;
  }

  sortWithActiveFirst(
    projects: ProjectSummary[],
    activeProjectName: string | undefined,
    reviewCounts?: Map<string, { review: number; conflicts: number }>,
  ): ProjectNode[] {
    const nodes: ProjectNode[] = projects.map((project) => {
      const key = project.name.toLowerCase();
      const counts = reviewCounts?.get(key);
      return {
        kind: "project" as const,
        projectName: project.name,
        brief: project.brief,
        active: activeProjectName !== undefined && project.name === activeProjectName,
        reviewCount: counts?.review,
        conflictCount: counts?.conflicts,
      };
    });
    if (activeProjectName) {
      nodes.sort((a, b) => {
        if (a.active && !b.active) return -1;
        if (!a.active && b.active) return 1;
        return 0;
      });
    }
    return nodes;
  }

  async getProjectNodes(): Promise<PhrenNode[]> {
    try {
      const projects = await this.fetchProjects();
      if (projects.length === 0) {
        return [{ kind: "message", label: "No projects yet \u2014 click + to add one", description: "", iconId: "add" }];
      }

      const stores = await this.fetchStores();
      const primaryStoreName = stores.find((s) => s.role === "primary")?.name ?? "personal";
      const resolvedStore = (p: ProjectSummary) => p.store ?? primaryStoreName;
      const storeNames = [...new Set(projects.map(resolvedStore))];
      if (storeNames.length > 1) {
        const storeReviewCounts = await this.fetchReviewCountsByStore(projects, resolvedStore);
        return storeNames.map((storeName) => {
          const storeProjects = projects.filter((p) => resolvedStore(p) === storeName);
          const storeInfo = stores.find((s) => s.name === storeName);
          const counts = storeReviewCounts.get(storeName);
          return {
            kind: "storeGroup" as const,
            storeName,
            role: storeInfo?.role ?? "team",
            count: storeProjects.length,
            syncMode: storeInfo?.syncMode,
            lastSync: storeInfo?.lastSync,
            reviewCount: counts?.review,
            conflictCount: counts?.conflicts,
          };
        });
      }

      const ctx = this.readDeviceContext();
      const activeProjectName = this.detectActiveProject(projects);
      const [reviewCounts] = await Promise.all([
        this.fetchReviewCountsByProject(),
      ]);
      if (ctx.activeProjects.size === 0) {
        return this.sortWithActiveFirst(projects, activeProjectName, reviewCounts);
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

  async getProjectNodesForStore(storeName: string): Promise<PhrenNode[]> {
    try {
      const [projects, stores, reviewCounts] = await Promise.all([
        this.fetchProjects(),
        this.fetchStores(),
        this.fetchReviewCountsByProject(),
      ]);
      const primaryStoreName = stores.find((s) => s.role === "primary")?.name ?? "personal";
      const filtered = projects.filter((p) => (p.store ?? primaryStoreName) === storeName);
      const activeProjectName = this.detectActiveProject(filtered);
      return this.sortWithActiveFirst(filtered, activeProjectName, reviewCounts);
    } catch (error) {
      return [this.errorNode("Failed to load projects", error)];
    }
  }

  async getProjectNodesForGroup(group: "device" | "other"): Promise<PhrenNode[]> {
    try {
      const [allProjects, reviewCounts] = await Promise.all([
        this.fetchProjects(),
        this.fetchReviewCountsByProject(),
      ]);
      const ctx = this.readDeviceContext();
      const filtered = group === "device"
        ? allProjects.filter((p) => ctx.activeProjects.has(p.name.toLowerCase()))
        : allProjects.filter((p) => !ctx.activeProjects.has(p.name.toLowerCase()));
      const activeProjectName = this.detectActiveProject(allProjects);
      return this.sortWithActiveFirst(filtered, activeProjectName, reviewCounts);
    } catch (error) {
      return [this.errorNode("Failed to load projects", error)];
    }
  }

  // --- Manage ---

  async getManageNodes(lastHealthOk: boolean | undefined): Promise<PhrenNode[]> {
    const nodes: PhrenNode[] = [];
    nodes.push({ kind: "manageItem", item: "health", label: "Health", value: lastHealthOk === true ? "ok" : lastHealthOk === false ? "issues" : "..." });

    try {
      const stores = await this.fetchStores();
      if (stores.length > 0) {
        for (const store of stores) {
          const syncTime = store.lastSync ? formatRelativeTime(store.lastSync) : "never";
          const syncLabel = store.syncMode ? `${store.syncMode} \u00b7 ${syncTime}` : syncTime;
          nodes.push({
            kind: "manageItem",
            item: "storeSync",
            label: store.name,
            value: syncLabel,
            storeName: store.name,
            syncMode: store.syncMode,
          });
        }
      } else {
        const ctx = this.readDeviceContext();
        nodes.push({ kind: "manageItem", item: "lastSync", label: "Sync", value: ctx.lastSync || "(never)" });
      }
    } catch {
      const ctx = this.readDeviceContext();
      nodes.push({ kind: "manageItem", item: "lastSync", label: "Sync", value: ctx.lastSync || "(never)" });
    }

    return nodes;
  }

  getMachineNodes(): PhrenNode[] {
    const ctx = this.readDeviceContext();
    const nodes: PhrenNode[] = [];
    nodes.push({ kind: "manageItem", item: "machine", label: "Machine", value: ctx.machine || "(unset)" });
    nodes.push({ kind: "manageItem", item: "profile", label: "Profile", value: `${ctx.machine} → ${ctx.profile || "none"}` });
    return nodes;
  }

  // --- getParent helpers ---

  async fetchStores(): Promise<Array<{ name: string; role: string; exists: boolean; syncMode?: string; lastSync?: string }>> {
    return this.cachedFetch("stores", async () => {
      try {
        const raw = await this.client.storeList();
        const data = responseData(raw);
        const stores = asArray(data?.stores);
        return stores.map((s) => {
          const r = asRecord(s);
          return {
            name: asString(r?.name) ?? "",
            role: asString(r?.role) ?? "primary",
            exists: asBoolean(r?.exists) ?? true,
            syncMode: asString(r?.sync),
            lastSync: asString(r?.lastSync),
          };
        }).filter((s) => s.name);
      } catch {
        return [];
      }
    });
  }

  async fetchProjects(): Promise<ProjectSummary[]> {
    return this.cachedFetch("projects", async () => {
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
        const store = asString(record?.store);
        const source = asString(record?.source);
        parsed.push({ name, brief, store, source });
      }

      return parsed;
    });
  }

  // --- Private fetch helpers ---

  private fetchFindings(projectName: string): Promise<FindingSummary[]> {
    return this.cachedFetch(`findings:${projectName}`, async () => {
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
          type: asString(record?.type),
          confidence: asNumber(record?.confidence),
          supersededBy: asString(record?.supersededBy),
          supersedes: asString(record?.supersedes),
          contradicts: contradicts?.length ? contradicts : undefined,
          potentialDuplicates: potentialDuplicates?.length ? potentialDuplicates : undefined,
        });
      }

      return parsed;
    });
  }


  private fetchNotes(projectName: string): Promise<NoteSummary[]> {
    return this.cachedFetch(`notes:${projectName}`, async () => {
      const raw = await this.client.getNotes(projectName);
      const data = responseData(raw);
      const notes = asArray(data?.notes);
      const parsed: NoteSummary[] = [];
      for (const entry of notes) {
        const record = asRecord(entry);
        const id = asString(record?.id);
        const text = asString(record?.text);
        const date = asString(record?.date);
        if (!id || !text || !date) continue;
        parsed.push({
          id,
          text,
          date,
          time: asString(record?.time) ?? "00:00:00",
          promoted: asBoolean(record?.promoted) ?? false,
        });
      }
      return parsed;
    });
  }

  private fetchQueueItems(projectName?: string): Promise<QueueItemSummary[]> {
    return this.cachedFetch(`queueItems:${projectName ?? "__all__"}`, async () => {
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
    });
  }

  private async fetchReviewCountsByProject(): Promise<Map<string, { review: number; conflicts: number }>> {
    const counts = new Map<string, { review: number; conflicts: number }>();
    try {
      const items = await this.fetchQueueItems();
      for (const item of items) {
        const key = item.projectName.toLowerCase();
        if (!counts.has(key)) counts.set(key, { review: 0, conflicts: 0 });
        const entry = counts.get(key)!;
        if (item.section === "Conflicts") entry.conflicts++;
        else entry.review++;
      }
    } catch { /* best-effort */ }
    return counts;
  }

  private async fetchReviewCountsByStore(
    projects: ProjectSummary[],
    resolvedStore: (p: ProjectSummary) => string,
  ): Promise<Map<string, { review: number; conflicts: number }>> {
    const counts = new Map<string, { review: number; conflicts: number }>();
    try {
      const items = await this.fetchQueueItems();
      const projectStore = new Map<string, string>();
      for (const p of projects) {
        projectStore.set(p.name.toLowerCase(), resolvedStore(p));
      }
      for (const item of items) {
        const storeName = projectStore.get(item.projectName.toLowerCase());
        if (!storeName) continue;
        if (!counts.has(storeName)) {
          counts.set(storeName, { review: 0, conflicts: 0 });
        }
        const entry = counts.get(storeName)!;
        if (item.section === "Conflicts") {
          entry.conflicts++;
        } else {
          entry.review++;
        }
      }
    } catch {
      // Best-effort: don't fail store listing if review queue is unavailable
    }
    return counts;
  }

  private fetchSkills(): Promise<SkillSummary[]> {
    return this.cachedFetch("skills", async () => {
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
    });
  }

  private fetchSessions(projectName: string): Promise<SessionSummary[]> {
    return this.cachedFetch(`sessions:${projectName}`, async () => {
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
    });
  }

  private fetchSessionArtifacts(projectName: string, sessionId: string): Promise<SessionArtifactSummary> {
    return this.cachedFetch(`sessionArtifacts:${projectName}:${sessionId}`, async () => {
      const raw = await this.client.sessionHistory({ sessionId, project: projectName });
      const data = responseData(raw);
      const findingsRaw = asArray(data?.findings);

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

      return { findings };
    });
  }

  private fetchHooks(): Promise<unknown> {
    return this.cachedFetch("hooks", () => this.client.listHooks());
  }

  private fetchHookErrors(): Promise<unknown> {
    return this.cachedFetch("hookErrors", () => this.client.listHookErrors());
  }

  private async cachedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    if (this.cache.has(key)) {
      return this.cache.get(key) as T;
    }
    const generationAtStart = this.cacheGeneration;
    const result = await fetcher();
    if (this.cacheGeneration !== generationAtStart) {
      return result;
    }
    this.cache.set(key, result);
    return result;
  }

  private errorNode(label: string, error: unknown): MessageNode {
    const description = error instanceof Error ? error.message : String(error);
    return { kind: "message", label, description, tooltip: "Phren: Show Log", iconId: "warning" };
  }
}
