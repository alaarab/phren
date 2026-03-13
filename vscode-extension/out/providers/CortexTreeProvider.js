"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CortexTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
const profileConfig_1 = require("../profileConfig");
class CortexTreeProvider {
    constructor(client, storePath) {
        this.client = client;
        this.storePath = storePath;
        this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    }
    setDateFilter(filter) {
        this.dateFilter = filter;
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }
    getDateFilter() {
        return this.dateFilter;
    }
    dispose() {
        this.onDidChangeTreeDataEmitter.dispose();
    }
    refresh() {
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }
    async getChildren(element) {
        try {
            return await this.getChildrenInner(element);
        }
        catch (error) {
            console.error(`[cortex-tree] getChildren crash:`, error, `element:`, JSON.stringify(element));
            return [{ kind: "message", label: `Error: ${error instanceof Error ? error.message : String(error)}`, iconId: "warning" }];
        }
    }
    async getChildrenInner(element) {
        if (!element) {
            return this.getRootSections();
        }
        if (element.kind === "rootSection") {
            if (element.section === "projects") {
                return this.getProjectNodes();
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
    getTreeItem(element) {
        try {
            return this.getTreeItemInner(element);
        }
        catch (error) {
            console.error(`[cortex-tree] getTreeItem crash:`, error, `element:`, JSON.stringify(element));
            const item = new vscode.TreeItem(`(error: ${error instanceof Error ? error.message : String(error)})`, vscode.TreeItemCollapsibleState.None);
            item.iconPath = themeIcon("warning");
            return item;
        }
    }
    getTreeItemInner(element) {
        if (!element || !element.kind) {
            return new vscode.TreeItem("(unknown)", vscode.TreeItemCollapsibleState.None);
        }
        switch (element.kind) {
            case "rootSection": {
                const labels = { projects: "Projects", review: "Review", skills: "Skills", hooks: "Hooks", graph: "Entity Graph", manage: "Manage" };
                const icons = { projects: "folder-library", review: "inbox", skills: "extensions", hooks: "plug", graph: "type-hierarchy", manage: "gear" };
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
                item.description = element.description;
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
                const categoryLabels = { findings: "Findings", sessions: "Sessions", task: "Tasks", queue: "Review Queue", reference: "Reference" };
                let categoryLabel = categoryLabels[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1);
                if (cat === "findings" && this.dateFilter) {
                    categoryLabel += ` [${this.dateFilter.label}]`;
                }
                const item = new vscode.TreeItem(categoryLabel, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = themeIcon(categoryIconId(cat));
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
            case "sessionDateGroup": {
                const label = formatDateLabel(element.date);
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
                item.description = `${element.count}`;
                item.iconPath = themeIcon("calendar");
                item.id = `cortex.sessionDateGroup.${element.projectName}.${element.date}`;
                return item;
            }
            case "finding": {
                const item = new vscode.TreeItem(truncate(element.text, 120), vscode.TreeItemCollapsibleState.None);
                const tooltipLines = [element.text];
                let iconId = "lightbulb";
                if (element.supersededBy) {
                    iconId = "lightbulb-autofix";
                    tooltipLines.push(`Superseded by: "${element.supersededBy}"`);
                }
                else if (element.contradicts?.length) {
                    iconId = "warning";
                    tooltipLines.push(`Contradicts: "${element.contradicts[0]}"`);
                }
                else if (element.potentialDuplicates?.length) {
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
                item.id = `cortex.finding.${element.projectName}.${element.id}`;
                item.contextValue = "cortex.finding";
                if (element.supersededBy) {
                    item.description = "(superseded)";
                }
                else if (element.contradicts?.length) {
                    item.description = "(conflict)";
                }
                else if (element.potentialDuplicates?.length) {
                    item.description = "(possible duplicate)";
                }
                item.command = {
                    command: "cortex.openFinding",
                    title: "Open Finding",
                    arguments: [element],
                };
                return item;
            }
            case "taskSectionGroup": {
                const sectionIcons = { Active: "play", Queue: "clock", Done: "check" };
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
                const queueIcons = { Review: "inbox", Stale: "history", Conflicts: "warning" };
                const item = new vscode.TreeItem(element.section, vscode.TreeItemCollapsibleState.Collapsed);
                item.description = `${element.count}`;
                item.iconPath = themeIcon(queueIcons[element.section] ?? "list-flat");
                item.id = `cortex.queueSectionGroup.${element.projectName}.${element.section}`;
                return item;
            }
            case "aggregateQueueSectionGroup": {
                const queueIcons = { Review: "inbox", Stale: "history", Conflicts: "warning" };
                const item = new vscode.TreeItem(element.section, vscode.TreeItemCollapsibleState.Collapsed);
                item.description = `${element.count}`;
                item.iconPath = themeIcon(queueIcons[element.section] ?? "list-flat");
                item.id = `cortex.aggregateQueueSectionGroup.${element.section}`;
                return item;
            }
            case "queueItem": {
                const item = new vscode.TreeItem(truncate(element.text, 120), vscode.TreeItemCollapsibleState.None);
                const confLabel = element.confidence !== undefined ? ` (${Math.round(element.confidence * 100)}%)` : "";
                item.tooltip = `${element.section} ${element.id}${confLabel}\n${element.date}\n${element.text}`;
                item.iconPath = themeIcon(element.risky ? "warning" : "mail");
                item.id = `cortex.queueItem.${element.projectName}.${element.id}`;
                item.description = element.showProjectName ? element.projectName : undefined;
                item.contextValue = "cortex.queue.item";
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
                item.contextValue = "cortex.hookItem";
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
                item.id = `cortex.session.${element.sessionId}`;
                item.contextValue = "cortex.session";
                return item;
            }
            case "sessionBucket": {
                const labels = { findings: "Findings", tasks: "Tasks" };
                const icons = { findings: "list-flat", tasks: "checklist" };
                const item = new vscode.TreeItem(labels[element.bucket], vscode.TreeItemCollapsibleState.Collapsed);
                item.description = `${element.count}`;
                item.iconPath = themeIcon(icons[element.bucket]);
                item.id = `cortex.sessionBucket.${element.projectName}.${element.sessionId}.${element.bucket}`;
                return item;
            }
            case "projectGroup": {
                const groupLabels = { device: "This Device", other: "Other" };
                const groupIcons = { device: "vm", other: "globe" };
                const item = new vscode.TreeItem(groupLabels[element.group] ?? element.group, vscode.TreeItemCollapsibleState.Expanded);
                item.description = `${element.count}`;
                item.iconPath = themeIcon(groupIcons[element.group] ?? "folder");
                item.id = `cortex.projectGroup.${element.group}`;
                return item;
            }
            case "manageItem": {
                const manageIcons = { health: "heart", profile: "account", machine: "vm", lastSync: "cloud" };
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.description = element.value;
                item.iconPath = themeIcon(manageIcons[element.item] ?? "info");
                item.id = `cortex.manage.${element.item}`;
                if (element.item === "health") {
                    item.command = { command: "cortex.doctor", title: "Run Doctor" };
                    item.tooltip = "Click to run Cortex Doctor";
                }
                else if (element.item === "profile") {
                    item.command = { command: "cortex.switchProfile", title: "Configure Profile" };
                    item.tooltip = "Click to update this machine's profile mapping in machines.yaml";
                }
                else if (element.item === "machine") {
                    item.command = { command: "cortex.configureMachine", title: "Configure Machine" };
                    item.tooltip = "Click to edit the machine alias stored in ~/.cortex/.machine-id";
                }
                else if (element.item === "lastSync") {
                    item.command = { command: "cortex.sync", title: "Sync Now" };
                    item.tooltip = "Click to sync Cortex";
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
    async getRootSections() {
        return [
            { kind: "rootSection", section: "projects" },
            { kind: "rootSection", section: "review" },
            { kind: "rootSection", section: "skills" },
            { kind: "rootSection", section: "hooks", description: await this.getHookSectionDescription() },
            { kind: "rootSection", section: "graph" },
            { kind: "rootSection", section: "manage" },
        ];
    }
    async getHookSectionDescription() {
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
        }
        catch {
            return undefined;
        }
    }
    async getFindingDateGroups(projectName) {
        try {
            let findings = await this.fetchFindings(projectName);
            // Apply date filter if set
            if (this.dateFilter) {
                findings = findings.filter((f) => {
                    if (f.date === "unknown")
                        return false;
                    if (this.dateFilter.from && f.date < this.dateFilter.from)
                        return false;
                    if (this.dateFilter.to && f.date > this.dateFilter.to)
                        return false;
                    return true;
                });
            }
            if (findings.length === 0) {
                const msg = this.dateFilter ? "No findings in date range" : "No findings";
                return [{ kind: "message", label: msg, iconId: "list-flat" }];
            }
            // Group by date, preserve order (most recent first)
            const dateOrder = [];
            const byDate = new Map();
            for (const f of findings) {
                const d = f.date || "unknown";
                if (!byDate.has(d)) {
                    dateOrder.push(d);
                    byDate.set(d, 0);
                }
                byDate.set(d, (byDate.get(d) ?? 0) + 1);
            }
            return dateOrder.map((date) => ({
                kind: "findingDateGroup",
                projectName,
                date,
                count: byDate.get(date) ?? 0,
            }));
        }
        catch (error) {
            return [this.errorNode("Failed to load findings", error)];
        }
    }
    async getFindingsForDate(projectName, date) {
        try {
            let findings = await this.fetchFindings(projectName);
            // Apply date filter if set
            if (this.dateFilter) {
                findings = findings.filter((f) => {
                    if (f.date === "unknown")
                        return false;
                    if (this.dateFilter.from && f.date < this.dateFilter.from)
                        return false;
                    if (this.dateFilter.to && f.date > this.dateFilter.to)
                        return false;
                    return true;
                });
            }
            return findings
                .filter((f) => (f.date || "unknown") === date)
                .map((finding) => ({
                kind: "finding",
                projectName,
                id: finding.id,
                date: finding.date,
                text: finding.text,
                supersededBy: finding.supersededBy,
                supersedes: finding.supersedes,
                contradicts: finding.contradicts,
                potentialDuplicates: finding.potentialDuplicates,
            }));
        }
        catch (error) {
            return [this.errorNode("Failed to load findings", error)];
        }
    }
    async getTaskSectionGroups(projectName) {
        try {
            const tasks = await this.fetchTasks(projectName);
            if (tasks.length === 0) {
                return [{ kind: "message", label: "No task items", iconId: "checklist" }];
            }
            const sections = ["Active", "Queue", "Done"];
            const groups = [];
            for (const section of sections) {
                const count = tasks.filter((t) => t.section === section).length;
                if (count > 0) {
                    groups.push({
                        kind: "taskSectionGroup",
                        projectName,
                        section,
                        count,
                    });
                }
            }
            return groups.length > 0 ? groups : [{ kind: "message", label: "No task items", iconId: "checklist" }];
        }
        catch (error) {
            return [this.errorNode("Failed to load task", error)];
        }
    }
    async getTasksForSection(projectName, section) {
        try {
            const tasks = await this.fetchTasks(projectName);
            return tasks
                .filter((t) => t.section === section)
                .map((task) => ({
                kind: "task",
                projectName,
                id: task.id,
                line: task.line,
                section: task.section,
                checked: task.checked,
            }));
        }
        catch (error) {
            return [this.errorNode("Failed to load tasks", error)];
        }
    }
    async getQueueSectionGroups(projectName) {
        try {
            const items = await this.fetchQueueItems(projectName);
            if (items.length === 0) {
                return [{ kind: "message", label: "No items in review queue", iconId: "inbox" }];
            }
            const sections = ["Review", "Stale", "Conflicts"];
            const groups = [];
            for (const section of sections) {
                const count = items.filter((i) => i.section === section).length;
                if (count > 0) {
                    groups.push({
                        kind: "queueSectionGroup",
                        projectName,
                        section,
                        count,
                    });
                }
            }
            return groups.length > 0 ? groups : [{ kind: "message", label: "No items in review queue", iconId: "inbox" }];
        }
        catch (error) {
            return [this.errorNode("Failed to load review queue", error)];
        }
    }
    async getQueueItemsForSection(projectName, section) {
        try {
            const items = await this.fetchQueueItems(projectName);
            return items
                .filter((i) => i.section === section)
                .map((item) => ({
                kind: "queueItem",
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
        }
        catch (error) {
            return [this.errorNode("Failed to load queue items", error)];
        }
    }
    async getAggregateQueueSectionGroups() {
        try {
            const items = await this.fetchQueueItems();
            if (items.length === 0) {
                return [{ kind: "message", label: "No items in review queue", iconId: "inbox" }];
            }
            const sections = ["Review", "Stale", "Conflicts"];
            return sections
                .map((section) => ({
                kind: "aggregateQueueSectionGroup",
                section,
                count: items.filter((item) => item.section === section).length,
            }))
                .filter((group) => group.count > 0);
        }
        catch (error) {
            return [this.errorNode("Failed to load review queue", error)];
        }
    }
    async getAggregateQueueItemsForSection(section) {
        try {
            const items = await this.fetchQueueItems();
            return items
                .filter((item) => item.section === section)
                .map((item) => ({
                kind: "queueItem",
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
        }
        catch (error) {
            return [this.errorNode("Failed to load queue items", error)];
        }
    }
    async getSessionDateGroups(projectName) {
        try {
            const sessions = await this.fetchSessions(projectName);
            if (sessions.length === 0) {
                return [{ kind: "message", label: "No sessions found", iconId: "history" }];
            }
            const dateOrder = [];
            const byDate = new Map();
            for (const session of sessions) {
                const date = session.date || "unknown";
                if (!byDate.has(date)) {
                    dateOrder.push(date);
                    byDate.set(date, 0);
                }
                byDate.set(date, (byDate.get(date) ?? 0) + 1);
            }
            return dateOrder.map((date) => ({
                kind: "sessionDateGroup",
                projectName,
                date,
                count: byDate.get(date) ?? 0,
            }));
        }
        catch (error) {
            return [this.errorNode("Failed to load sessions", error)];
        }
    }
    async getSessionsForDate(projectName, date) {
        try {
            const sessions = await this.fetchSessions(projectName);
            return sessions
                .filter((session) => session.date === date)
                .map((session) => ({
                kind: "session",
                projectName,
                date: session.date,
                sessionId: session.sessionId,
                startedAt: session.startedAt,
                durationMins: session.durationMins,
                summary: session.summary,
                findingsAdded: session.findingsAdded,
                status: session.status,
            }));
        }
        catch (error) {
            return [this.errorNode("Failed to load sessions", error)];
        }
    }
    async getSessionChildren(session) {
        try {
            const artifacts = await this.fetchSessionArtifacts(session.projectName, session.sessionId);
            const children = [];
            if (artifacts.findings.length > 0) {
                children.push({
                    kind: "sessionBucket",
                    projectName: session.projectName,
                    sessionId: session.sessionId,
                    bucket: "findings",
                    count: artifacts.findings.length,
                });
            }
            if (artifacts.tasks.length > 0) {
                children.push({
                    kind: "sessionBucket",
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
        }
        catch (error) {
            return [this.errorNode("Failed to load session details", error)];
        }
    }
    async getSessionBucketChildren(bucket) {
        try {
            const artifacts = await this.fetchSessionArtifacts(bucket.projectName, bucket.sessionId);
            if (bucket.bucket === "findings") {
                if (artifacts.findings.length === 0) {
                    return [{ kind: "message", label: "No findings", iconId: "list-flat" }];
                }
                return artifacts.findings.map((finding) => ({
                    kind: "finding",
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
                kind: "task",
                projectName: bucket.projectName,
                id: task.id,
                line: task.line,
                section: task.section,
                checked: task.checked,
            }));
        }
        catch (error) {
            return [this.errorNode("Failed to load session artifacts", error)];
        }
    }
    async getReferenceNodes(projectName) {
        try {
            const raw = await this.client.getProjectSummary(projectName);
            const data = responseData(raw);
            const files = asArray(data?.files);
            const refFiles = [];
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
        }
        catch (error) {
            return [this.errorNode("Failed to load reference files", error)];
        }
    }
    async getSkillGroupNodes() {
        try {
            const skills = await this.fetchSkills();
            if (skills.length === 0) {
                return [{ kind: "message", label: "No skills installed", iconId: "extensions" }];
            }
            const sources = new Set();
            for (const skill of skills) {
                sources.add(skill.source);
            }
            // Sort: global first, then alphabetical
            const sorted = [...sources].sort((a, b) => {
                if (a === "global")
                    return -1;
                if (b === "global")
                    return 1;
                return a.localeCompare(b);
            });
            return sorted.map((source) => ({ kind: "skillGroup", source }));
        }
        catch (error) {
            return [this.errorNode("Failed to load skills", error)];
        }
    }
    async getSkillsForGroup(source) {
        try {
            const skills = await this.fetchSkills();
            const filtered = skills.filter((s) => s.source === source);
            if (filtered.length === 0) {
                return [{ kind: "message", label: "No skills in this group", iconId: "extensions" }];
            }
            return filtered.map((skill) => ({
                kind: "skill",
                name: skill.name,
                source: skill.source,
                enabled: skill.enabled,
                path: skill.path,
            }));
        }
        catch (error) {
            return [this.errorNode("Failed to load skills", error)];
        }
    }
    async getHookNodes() {
        try {
            const raw = await this.client.listHooks();
            const data = responseData(raw);
            const tools = asArray(data?.tools);
            if (tools.length === 0) {
                return [{ kind: "message", label: "No hooks configured", iconId: "plug" }];
            }
            const nodes = [];
            for (const entry of tools) {
                const record = asRecord(entry);
                const tool = asString(record?.tool);
                if (!tool) {
                    continue;
                }
                const enabled = asBoolean(record?.enabled) ?? false;
                nodes.push({ kind: "hook", tool, enabled });
            }
            return nodes;
        }
        catch (error) {
            return [this.errorNode("Failed to load hooks", error)];
        }
    }
    readDeviceContext() {
        return (0, profileConfig_1.readDeviceContext)(this.storePath);
    }
    async getProjectNodes() {
        try {
            const projects = await this.fetchProjects();
            if (projects.length === 0) {
                return [{ kind: "message", label: "No projects found", description: "Index projects to populate Cortex.", iconId: "info" }];
            }
            const ctx = this.readDeviceContext();
            if (ctx.activeProjects.size === 0) {
                // No device context -- show flat list
                return projects.map((project) => ({
                    kind: "project",
                    projectName: project.name,
                    brief: project.brief,
                }));
            }
            const deviceProjects = projects.filter((p) => ctx.activeProjects.has(p.name.toLowerCase()));
            const otherProjects = projects.filter((p) => !ctx.activeProjects.has(p.name.toLowerCase()));
            const groups = [];
            if (deviceProjects.length > 0) {
                groups.push({ kind: "projectGroup", group: "device", count: deviceProjects.length });
            }
            if (otherProjects.length > 0) {
                groups.push({ kind: "projectGroup", group: "other", count: otherProjects.length });
            }
            return groups;
        }
        catch (error) {
            return [this.errorNode("Failed to load projects", error)];
        }
    }
    async getProjectNodesForGroup(group) {
        try {
            const projects = await this.fetchProjects();
            const ctx = this.readDeviceContext();
            const filtered = group === "device"
                ? projects.filter((p) => ctx.activeProjects.has(p.name.toLowerCase()))
                : projects.filter((p) => !ctx.activeProjects.has(p.name.toLowerCase()));
            return filtered.map((project) => ({
                kind: "project",
                projectName: project.name,
                brief: project.brief,
            }));
        }
        catch (error) {
            return [this.errorNode("Failed to load projects", error)];
        }
    }
    getManageNodes() {
        const ctx = this.readDeviceContext();
        const nodes = [];
        nodes.push({ kind: "manageItem", item: "health", label: "Health", value: this.lastHealthOk === true ? "ok" : this.lastHealthOk === false ? "error" : "unknown" });
        nodes.push({ kind: "manageItem", item: "profile", label: "Profile", value: ctx.profile || "(none)" });
        nodes.push({ kind: "manageItem", item: "machine", label: "Machine", value: ctx.machine });
        nodes.push({ kind: "manageItem", item: "lastSync", label: "Last Sync", value: ctx.lastSync || "(never)" });
        return nodes;
    }
    setHealthStatus(ok) {
        if (this.lastHealthOk === ok)
            return;
        this.lastHealthOk = ok;
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }
    // --- Raw fetch helpers ---
    async fetchProjects() {
        const raw = await this.client.listProjects();
        const data = responseData(raw);
        const projects = asArray(data?.projects);
        const parsed = [];
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
    async fetchFindings(projectName) {
        const raw = await this.client.getFindings(projectName);
        const data = responseData(raw);
        const findings = asArray(data?.findings);
        const parsed = [];
        for (const entry of findings) {
            const record = asRecord(entry);
            const id = asString(record?.id);
            const text = asString(record?.text);
            if (!id || !text) {
                continue;
            }
            const contradictsRaw = record?.contradicts;
            const contradicts = Array.isArray(contradictsRaw)
                ? contradictsRaw.filter((v) => typeof v === "string")
                : undefined;
            const potentialDuplicatesRaw = record?.potentialDuplicates;
            const potentialDuplicates = Array.isArray(potentialDuplicatesRaw)
                ? potentialDuplicatesRaw.filter((v) => typeof v === "string")
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
    async fetchTasks(projectName) {
        const raw = await this.client.getTasks(projectName, { status: "all", done_limit: 50 });
        const data = responseData(raw);
        const items = asRecord(data?.items);
        const sections = ["Active", "Queue", "Done"];
        const tasks = [];
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
    async fetchQueueItems(projectName) {
        const raw = await this.client.getReviewQueue(projectName);
        const data = responseData(raw);
        const items = asArray(data?.items);
        const parsed = [];
        for (const entry of items) {
            const record = asRecord(entry);
            const id = asString(record?.id);
            const text = asString(record?.text);
            const resolvedProjectName = asString(record?.project) ?? projectName;
            if (!id || !text || !resolvedProjectName) {
                continue;
            }
            const sectionRaw = asString(record?.section) ?? "Review";
            const section = (["Review", "Stale", "Conflicts"].includes(sectionRaw) ? sectionRaw : "Review");
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
    async fetchSkills() {
        const raw = await this.client.listSkills();
        const data = responseData(raw);
        const skills = asArray(data?.skills);
        const parsed = [];
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
    async fetchSessions(projectName) {
        const raw = await this.client.sessionHistory({ limit: 50, project: projectName });
        const response = asRecord(raw);
        const sessions = asArray(response?.data);
        const parsed = [];
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
    async fetchSessionArtifacts(projectName, sessionId) {
        const raw = await this.client.sessionHistory({ sessionId, project: projectName });
        const data = responseData(raw);
        const findingsRaw = asArray(data?.findings);
        const tasksRaw = asArray(data?.tasks);
        const findings = [];
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
        const tasks = [];
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
    errorNode(label, error) {
        const description = error instanceof Error ? error.message : String(error);
        return { kind: "message", label, description, iconId: "warning" };
    }
}
exports.CortexTreeProvider = CortexTreeProvider;
function categoryIconId(category) {
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
function taskIconId(task) {
    if (task.checked || task.section === "Done") {
        return "check";
    }
    if (task.section === "Active") {
        return "play";
    }
    return "clock";
}
function truncate(value, maxLength) {
    const compact = value.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
function asRecord(value) {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    return value;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function asStringArray(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const parsed = value.filter((entry) => typeof entry === "string");
    return parsed.length > 0 ? parsed : undefined;
}
function asBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
function asNumber(value) {
    return typeof value === "number" ? value : undefined;
}
function asTaskSection(value) {
    return value === "Active" || value === "Queue" || value === "Done" ? value : undefined;
}
function asSessionStatus(value) {
    return value === "active" || value === "ended" ? value : undefined;
}
function responseData(value) {
    const response = asRecord(value);
    return asRecord(response?.data);
}
function formatDateLabel(dateStr) {
    if (dateStr === "unknown") {
        return "Unknown date";
    }
    const parsed = new Date(dateStr + "T00:00:00");
    if (isNaN(parsed.getTime())) {
        return dateStr;
    }
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
    if (diffDays === 0) {
        return "Today";
    }
    if (diffDays === 1) {
        return "Yesterday";
    }
    if (diffDays < 7) {
        return `${diffDays} days ago`;
    }
    return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: parsed.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}
function formatSessionTimeLabel(startedAt) {
    const parsed = new Date(startedAt);
    if (isNaN(parsed.getTime())) {
        return startedAt;
    }
    return parsed.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
    });
}
function themeIcon(id) {
    if (id === "folder") {
        return vscode.ThemeIcon.Folder;
    }
    if (id === "file") {
        return vscode.ThemeIcon.File;
    }
    return new vscode.ThemeIcon(id);
}
//# sourceMappingURL=CortexTreeProvider.js.map