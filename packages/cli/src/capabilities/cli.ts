import type { CapabilityManifest } from "./types.js";

export const cliManifest: CapabilityManifest = {
  surface: "cli",
  version: "0.1.17",
  actions: {
    // Finding management
    "finding.add": { implemented: true, handler: "cli-actions.ts:handleAddFinding" },
    "finding.remove": { implemented: true, handler: "cli-namespaces.ts:handleFindingNamespace remove" },
    "finding.list": { implemented: true, handler: "cli.ts:search (findings visible via search)" },
    "finding.filter_by_date": { implemented: false, reason: "Search has no date filter flag" },
    "finding.pin": { implemented: true, handler: "cli-actions.ts:handlePin" },

    // Task management
    "task.add": { implemented: true, handler: "cli-namespaces.ts:handleTaskNamespace add" },
    "task.complete": { implemented: true, handler: "cli-namespaces.ts:handleTaskNamespace complete" },
    "task.remove": { implemented: false, reason: "No dedicated CLI task remove command" },
    "task.update": { implemented: true, handler: "cli-namespaces.ts:handleTaskNamespace update" },
    "task.list": { implemented: true, handler: "cli-actions.ts:handleTasks" },
    "task.pin": { implemented: false, reason: "Pin task is MCP-only" },
    "task.github_link": { implemented: false, reason: "GitHub link/promote is MCP-only" },

    // Hook management
    "hook.list": { implemented: true, handler: "cli-actions.ts:handleHooks list" },
    "hook.toggle": { implemented: true, handler: "cli-actions.ts:handleHooks enable/disable" },
    "hook.toggle_per_project": { implemented: false, reason: "Per-project hook toggle not exposed in CLI" },
    "hook.custom_crud": { implemented: false, reason: "Custom hooks CRUD not exposed in CLI" },
    "hook.errors": { implemented: false, reason: "Hook errors not exposed in CLI" },

    // Search
    "search.fts": { implemented: true, handler: "cli-actions.ts:handleSearch" },
    "search.fragment": { implemented: true, handler: "cli-actions.ts:handleFragmentSearch" },
    "search.related_docs": { implemented: true, handler: "cli-actions.ts:handleRelatedDocs" },
    "search.history": { implemented: true, handler: "cli-actions.ts:handleSearch --history" },

    // Graph
    "graph.read": { implemented: true, handler: "cli-graph.ts:handleGraphRead" },
    "graph.visualize": { implemented: false, reason: "Graph visualization is VS Code / web only" },
    "graph.link_findings": { implemented: true, handler: "cli-graph.ts:handleGraphLink" },

    // Config
    "config.get": { implemented: true, handler: "cli-config.ts:handleConfigGet (per-domain)" },
    "config.set": { implemented: true, handler: "cli-config.ts:handleConfigSet (proactivity, taskMode, findingSensitivity, retention, workflow, index)" },

    // Health / Sync / Session
    "health.check": { implemented: true, handler: "cli-actions.ts:handleDoctor" },
    "health.doctor_fix": { implemented: true, handler: "cli-actions.ts:handleDoctor --fix" },
    "health.sync": { implemented: true, handler: "hook-stop auto-commit" },
    "session.start": { implemented: true, handler: "cli-hooks-session.ts (hook)" },
    "session.end": { implemented: true, handler: "cli-hooks-stop.ts (hook)" },

    // Skill management
    "skill.list": { implemented: true, handler: "cli-actions.ts:handleSkillList" },
    "skill.read": { implemented: true, handler: "cli-actions.ts:handleSkills read" },
    "skill.enable": { implemented: false, reason: "No CLI command for skill enable/disable" },
    "skill.write": { implemented: false, reason: "No CLI command for skill write" },

    // Project management
    "project.list": { implemented: true, handler: "cli-actions.ts:handleProjects list" },
    "project.manage": { implemented: true, handler: "cli-actions.ts:handleProjects remove" },
    "project.summary": { implemented: false, reason: "No CLI command for project summary" },
    "export.project": { implemented: false, reason: "Export/import not exposed in CLI" },
    "import.project": { implemented: false, reason: "Export/import not exposed in CLI" },

    // Profile / Machine
    "profile.switch": { implemented: false, reason: "No CLI command for profile switch" },
    "profile.list": { implemented: true, handler: "cli-config.ts:config profiles" },
  },
};
