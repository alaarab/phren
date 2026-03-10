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
class CortexTreeProvider {
    constructor(client) {
        this.client = client;
        this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    }
    dispose() {
        this.onDidChangeTreeDataEmitter.dispose();
    }
    refresh() {
        this.onDidChangeTreeDataEmitter.fire();
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
                item.iconPath = themeIcon(categoryIconId(cat));
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
    async getProjectNodes() {
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
        }
        catch (error) {
            return [this.errorNode("Failed to load projects", error)];
        }
    }
    async getFindingNodes(projectName) {
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
        }
        catch (error) {
            return [this.errorNode("Failed to load findings", error)];
        }
    }
    async getBacklogNodes(projectName) {
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
        }
        catch (error) {
            return [this.errorNode("Failed to load backlog", error)];
        }
    }
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
            parsed.push({
                id,
                date: asString(record?.date) ?? "unknown",
                text,
            });
        }
        return parsed;
    }
    async fetchTasks(projectName) {
        const raw = await this.client.getTasks(projectName);
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
    if (category === "backlog") {
        return "checklist";
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
function asBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
function responseData(value) {
    const response = asRecord(value);
    return asRecord(response?.data);
}
function themeIcon(id) {
    if (id === "folder") {
        return vscode.ThemeIcon.Folder;
    }
    if (id === "file") {
        return vscode.ThemeIcon.File;
    }
    // ThemeIcon constructor may be private in some type def versions, but it exists at runtime
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new vscode.ThemeIcon(id);
}
//# sourceMappingURL=CortexTreeProvider.js.map