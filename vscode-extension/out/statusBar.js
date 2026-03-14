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
exports.PhrenStatusBar = void 0;
const vscode = __importStar(require("vscode"));
const HEALTH_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
class PhrenStatusBar {
    constructor(client) {
        this.client = client;
        this.disposables = [];
        this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusItem.command = "phren.doctor";
        this.statusItem.tooltip = "Phren health — click for Doctor";
        this.disposables.push(this.statusItem, vscode.window.onDidChangeActiveTextEditor(() => {
            this.render();
        }));
        this.render();
        this.statusItem.show();
    }
    /** Register a callback invoked whenever health status changes. */
    setOnHealthChanged(cb) {
        this.onHealthChanged = cb;
    }
    async initialize() {
        const projectNames = await this.fetchProjectNames();
        this.activeProjectName = this.activeProjectName && projectNames.includes(this.activeProjectName)
            ? this.activeProjectName
            : projectNames[0];
        this.render();
        // Start health polling
        await this.pollHealth();
        this.healthTimer = setInterval(() => { this.pollHealth().catch(() => { }); }, HEALTH_POLL_INTERVAL_MS);
    }
    getActiveProjectName() {
        return this.activeProjectName;
    }
    setActiveProjectName(projectName) {
        this.activeProjectName = projectName;
        this.render();
    }
    async promptForActiveProject() {
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
    dispose() {
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = undefined;
        }
        while (this.disposables.length > 0) {
            const disposable = this.disposables.pop();
            disposable?.dispose();
        }
    }
    async pollHealth() {
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
        }
        catch {
            const changed = this.healthOk !== false;
            this.healthOk = false;
            this.render();
            if (changed && this.onHealthChanged) {
                this.onHealthChanged(false);
            }
        }
    }
    async fetchProjectNames() {
        const raw = await this.client.listProjects();
        const projects = this.parseProjects(raw);
        return projects.map((project) => project.name);
    }
    parseProjects(value) {
        const data = responseData(value);
        const projects = asArray(data?.projects);
        const parsed = [];
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
    render() {
        const projectName = this.activeProjectName ?? "No project";
        const badge = this.healthOk === true ? " [ok]" : this.healthOk === false ? " [!]" : "";
        this.statusItem.text = `$(database) Phren: ${projectName}${badge}`;
    }
}
exports.PhrenStatusBar = PhrenStatusBar;
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
function responseData(value) {
    const response = asRecord(value);
    return asRecord(response?.data);
}
//# sourceMappingURL=statusBar.js.map