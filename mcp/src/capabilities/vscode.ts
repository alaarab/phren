import type { CapabilityManifest } from "./types.js";

export const vscodeManifest: CapabilityManifest = {
  surface: "vscode",
  version: "1.31.1",
  actions: {
    // Finding management
    "finding.add": { implemented: true, handler: "extension.ts:cortex.addFinding" },
    "finding.remove": { implemented: true, handler: "extension.ts:cortex.removeFinding" },
    "finding.list": { implemented: true, handler: "CortexTreeProvider.ts:findings section" },
    "finding.filter_by_date": { implemented: true, handler: "extension.ts:cortex.filterFindingsByDate" },
    "finding.pin": { implemented: true, handler: "extension.ts:cortex.pinMemory" },

    // Task management
    "task.add": { implemented: true, handler: "extension.ts:cortex.addTask" },
    "task.complete": { implemented: true, handler: "extension.ts:cortex.completeTask" },
    "task.remove": { implemented: true, handler: "extension.ts:cortex.removeTask" },
    "task.update": { implemented: false, reason: "No VS Code command for task field updates" },
    "task.list": { implemented: true, handler: "CortexTreeProvider.ts:tasks section" },
    "task.pin": { implemented: false, reason: "No VS Code command for task pinning" },
    "task.github_link": { implemented: false, reason: "GitHub link/promote is MCP-only" },

    // Hook management
    "hook.list": { implemented: true, handler: "extension.ts:cortex.hooksStatus" },
    "hook.toggle": { implemented: true, handler: "extension.ts:cortex.toggleHook, cortex.toggleHooksCommand" },
    "hook.toggle_per_project": { implemented: false, reason: "Per-project hook toggle not exposed in VS Code" },
    "hook.custom_crud": { implemented: false, reason: "Custom hooks CRUD not exposed in VS Code" },
    "hook.errors": { implemented: false, reason: "Hook errors not exposed in VS Code" },

    // Search
    "search.fts": { implemented: true, handler: "searchQuickPick.ts:showSearchQuickPick" },
    "search.entity": { implemented: false, reason: "No entity search command in VS Code" },
    "search.related_docs": { implemented: false, reason: "No related docs command in VS Code" },
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
    "config.access": { implemented: false, reason: "Config tools are CLI-only" },
    "config.index": { implemented: false, reason: "Config tools are CLI-only" },

    // Health / Sync / Session
    "health.check": { implemented: true, handler: "extension.ts:cortex.doctor" },
    "health.doctor_fix": { implemented: false, reason: "Doctor --fix requires interactive confirmation" },
    "health.sync": { implemented: true, handler: "extension.ts:cortex.sync" },
    "session.start": { implemented: false, reason: "Session lifecycle is hook-driven, not VS Code commands" },
    "session.end": { implemented: false, reason: "Session lifecycle is hook-driven, not VS Code commands" },

    // Skill management
    "skill.list": { implemented: true, handler: "CortexTreeProvider.ts:skills section" },
    "skill.read": { implemented: true, handler: "skillEditor.ts:showSkillEditor" },
    "skill.enable": { implemented: true, handler: "extension.ts:cortex.toggleSkill" },
    "skill.write": { implemented: false, reason: "No VS Code command for skill write" },

    // Project management
    "project.list": { implemented: true, handler: "CortexTreeProvider.ts:projects section" },
    "project.manage": { implemented: true, handler: "extension.ts:cortex.manageProject" },
    "project.summary": { implemented: true, handler: "CortexTreeProvider.ts:project detail view" },
    "export.project": { implemented: false, reason: "Export/import not exposed in VS Code" },
    "import.project": { implemented: false, reason: "Export/import not exposed in VS Code" },

    // Profile / Machine
    "profile.switch": { implemented: true, handler: "extension.ts:cortex.switchProfile" },
    "profile.list": { implemented: true, handler: "CortexTreeProvider.ts:manage section (profiles dir)" },
  },
};
