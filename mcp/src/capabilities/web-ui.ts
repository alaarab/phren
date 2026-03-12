import type { CapabilityManifest } from "./types.js";

export const webUiManifest: CapabilityManifest = {
  surface: "web-ui",
  version: "1.31.1",
  actions: {
    // Finding management
    "finding.add": { implemented: false, reason: "Web UI is read-only for findings (review queue only)" },
    "finding.remove": { implemented: false, reason: "Web UI is read-only for findings" },
    "finding.list": { implemented: true, handler: "memory-ui-server.ts:/api/project-content" },
    "finding.filter_by_date": { implemented: false, reason: "No date filter in web UI API" },
    "finding.pin": { implemented: false, reason: "No pin action in web UI" },

    // Task management
    "task.add": { implemented: false, reason: "No task creation in web UI" },
    "task.complete": { implemented: false, reason: "No task completion in web UI" },
    "task.remove": { implemented: false, reason: "No task deletion in web UI" },
    "task.update": { implemented: false, reason: "No task update in web UI" },
    "task.list": { implemented: true, handler: "memory-ui-server.ts:/api/tasks" },
    "task.pin": { implemented: false, reason: "No task pinning in web UI" },
    "task.github_link": { implemented: false, reason: "No GitHub link in web UI" },

    // Hook management
    "hook.list": { implemented: true, handler: "memory-ui-server.ts:/api/hooks" },
    "hook.toggle": { implemented: true, handler: "memory-ui-server.ts:/api/hook-toggle" },
    "hook.toggle_per_project": { implemented: false, reason: "Per-project hook toggle not exposed in web UI" },
    "hook.custom_crud": { implemented: false, reason: "Custom hooks CRUD not exposed in web UI" },
    "hook.errors": { implemented: false, reason: "Hook errors not exposed in web UI" },

    // Search
    "search.fts": { implemented: false, reason: "No full-text search in web UI" },
    "search.entity": { implemented: false, reason: "No entity search in web UI" },
    "search.related_docs": { implemented: false, reason: "No related docs in web UI" },
    "search.history": { implemented: false, reason: "No search history in web UI" },

    // Graph
    "graph.read": { implemented: true, handler: "memory-ui-server.ts:/api/graph" },
    "graph.visualize": { implemented: true, handler: "memory-ui-page.ts:graph tab (Canvas2D + Barnes-Hut engine)" },
    "graph.link_findings": { implemented: false, reason: "No link findings action in web UI" },

    // Config
    "config.proactivity": { implemented: false, reason: "Config is CLI-only" },
    "config.task_mode": { implemented: true, handler: "memory-ui-server.ts:/api/settings (workflow policy)" },
    "config.retention": { implemented: false, reason: "Config is CLI-only" },
    "config.workflow": { implemented: true, handler: "memory-ui-server.ts:/api/settings (workflow policy)" },
    "config.access": { implemented: false, reason: "Config is CLI-only" },
    "config.index": { implemented: false, reason: "Config is CLI-only" },

    // Health / Sync / Session
    "health.check": { implemented: true, handler: "memory-ui-server.ts:/api/runtime-health" },
    "health.doctor_fix": { implemented: false, reason: "Doctor --fix is CLI-only" },
    "health.sync": { implemented: false, reason: "No sync action in web UI" },
    "session.start": { implemented: false, reason: "Session lifecycle is not web UI driven" },
    "session.end": { implemented: false, reason: "Session lifecycle is not web UI driven" },

    // Skill management
    "skill.list": { implemented: true, handler: "memory-ui-server.ts:/api/skills" },
    "skill.read": { implemented: true, handler: "memory-ui-server.ts:/api/skill-content" },
    "skill.enable": { implemented: true, handler: "memory-ui-server.ts:/api/skill-toggle" },
    "skill.write": { implemented: true, handler: "memory-ui-server.ts:/api/skill-save" },

    // Project management
    "project.list": { implemented: true, handler: "memory-ui-server.ts:/api/projects" },
    "project.manage": { implemented: false, reason: "No archive/unarchive in web UI" },
    "project.summary": { implemented: true, handler: "memory-ui-server.ts:/api/project-content" },
    "export.project": { implemented: false, reason: "Export/import not exposed in web UI" },
    "import.project": { implemented: false, reason: "Export/import not exposed in web UI" },

    // Profile / Machine
    "profile.switch": { implemented: false, reason: "No profile switching in web UI" },
    "profile.list": { implemented: false, reason: "No profile listing in web UI" },
  },
};
