import type { CapabilityManifest } from "./types.js";

export const vscodeManifest: CapabilityManifest = {
  surface: "vscode",
  version: "0.0.17",
  actions: {
    // Finding management
    "finding.add": { implemented: true, handler: "extension.ts:phren.addFinding" },
    "finding.remove": { implemented: true, handler: "extension.ts:phren.removeFinding" },
    "finding.list": { implemented: true, handler: "PhrenTreeProvider.ts:findings section" },
    "finding.filter_by_date": { implemented: true, handler: "extension.ts:phren.filterFindingsByDate" },
    "finding.pin": { implemented: true, handler: "extension.ts:phren.pinMemory" },

    // Task management
    "task.add": { implemented: true, handler: "extension.ts:phren.addTask" },
    "task.complete": { implemented: true, handler: "extension.ts:phren.completeTask" },
    "task.remove": { implemented: true, handler: "extension.ts:phren.removeTask" },
    "task.update": { implemented: true, handler: "extension.ts:phren.updateTask, taskViewer.ts:save" },
    "task.list": { implemented: true, handler: "PhrenTreeProvider.ts:tasks section" },
    "task.pin": { implemented: true, handler: "extension.ts:phren.pinTask" },
    "task.github_link": { implemented: false, reason: "GitHub link/promote is MCP-only" },

    // Hook management
    "hook.list": { implemented: true, handler: "extension.ts:phren.hooksStatus" },
    "hook.toggle": { implemented: true, handler: "extension.ts:phren.toggleHook, phren.toggleHooksCommand" },
    "hook.toggle_per_project": { implemented: false, reason: "Per-project hook toggle not exposed in VS Code" },
    "hook.custom_crud": { implemented: false, reason: "Custom hooks CRUD not exposed in VS Code" },
    "hook.errors": { implemented: false, reason: "Hook errors not exposed in VS Code" },

    // Search
    "search.fts": { implemented: true, handler: "searchQuickPick.ts:showSearchQuickPick" },
    "search.fragment": { implemented: true, handler: "phrenClient.ts:searchFragments" },
    "search.related_docs": { implemented: true, handler: "phrenClient.ts:getRelatedDocs" },
    "search.history": { implemented: true, handler: "searchQuickPick.ts:searchHistory (in-memory)" },

    // Graph
    "graph.read": { implemented: true, handler: "graphWebview.ts:showGraphWebview" },
    "graph.visualize": { implemented: true, handler: "graphWebview.ts:showGraphWebview (webview panel)" },
    "graph.link_findings": { implemented: false, reason: "Link findings is MCP-only" },

    // Config
    "config.proactivity": { implemented: false, reason: "Config tools are CLI-only" },
    "config.task_mode": { implemented: false, reason: "Config tools are CLI-only" },
    "config.retention": { implemented: false, reason: "Config tools are CLI-only" },
    "config.workflow": { implemented: false, reason: "Config tools are CLI-only" },
    "config.index": { implemented: false, reason: "Config tools are CLI-only" },

    // Health / Sync / Session
    "health.check": { implemented: true, handler: "extension.ts:phren.doctor" },
    "health.doctor_fix": { implemented: true, handler: "extension.ts:phren.doctorFix" },
    "health.sync": { implemented: true, handler: "extension.ts:phren.sync" },
    "session.start": { implemented: true, handler: "extension.ts:phren.sessionStart" },
    "session.end": { implemented: true, handler: "extension.ts:phren.sessionEnd" },

    // Skill management
    "skill.list": { implemented: true, handler: "PhrenTreeProvider.ts:skills section" },
    "skill.read": { implemented: true, handler: "skillEditor.ts:showSkillEditor" },
    "skill.enable": { implemented: true, handler: "extension.ts:phren.toggleSkill" },
    "skill.write": { implemented: true, handler: "skillEditor.ts:showSkillEditor" },

    // Project management
    "project.list": { implemented: true, handler: "PhrenTreeProvider.ts:projects section" },
    "project.manage": { implemented: true, handler: "extension.ts:phren.manageProject" },
    "project.summary": { implemented: true, handler: "PhrenTreeProvider.ts:project detail view" },
    "export.project": { implemented: false, reason: "Export/import not exposed in VS Code" },
    "import.project": { implemented: false, reason: "Export/import not exposed in VS Code" },

    // Profile / Machine
    "profile.switch": { implemented: true, handler: "extension.ts:phren.switchProfile" },
    "profile.list": { implemented: true, handler: "PhrenTreeProvider.ts:manage section (profiles dir)" },
  },
};
