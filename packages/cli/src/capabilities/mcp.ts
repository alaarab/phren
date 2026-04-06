import type { CapabilityManifest } from "./types.js";

export const mcpManifest: CapabilityManifest = {
  surface: "mcp",
  version: "0.1.16",
  actions: {
    // Finding management
    "finding.add": { implemented: true, handler: "index.ts:add_finding" },
    "finding.remove": { implemented: true, handler: "index.ts:remove_finding" },
    "finding.list": { implemented: true, handler: "index.ts:get_findings" },
    "finding.filter_by_date": { implemented: false, reason: "get_findings has no date filter parameter" },
    "finding.pin": { implemented: true, handler: "index.ts:pin_memory" },

    // Task management
    "task.add": { implemented: true, handler: "index.ts:add_task" },
    "task.complete": { implemented: true, handler: "index.ts:complete_task" },
    "task.remove": { implemented: true, handler: "index.ts:remove_task" },
    "task.update": { implemented: true, handler: "index.ts:update_task" },
    "task.list": { implemented: true, handler: "index.ts:get_tasks" },
    "task.pin": { implemented: true, handler: "index.ts:update_task (pin)" },
    "task.github_link": { implemented: true, handler: "index.ts:update_task (github_issue/github_url)" },

    // Hook management
    "hook.list": { implemented: true, handler: "index.ts:list_hooks" },
    "hook.toggle": { implemented: true, handler: "index.ts:toggle_hooks" },
    "hook.toggle_per_project": { implemented: true, handler: "index.ts:toggle_hooks (project param)" },
    "hook.custom_crud": { implemented: true, handler: "index.ts:add_custom_hook, remove_custom_hook" },
    "hook.errors": { implemented: true, handler: "index.ts:list_hook_errors" },

    // Search
    "search.fts": { implemented: true, handler: "index.ts:search_knowledge" },
    "search.fragment": { implemented: true, handler: "index.ts:search_fragments" },
    "search.related_docs": { implemented: true, handler: "index.ts:get_related_docs" },
    "search.history": { implemented: false, reason: "Search history is CLI-only (search-history.jsonl)" },

    // Graph
    "graph.read": { implemented: true, handler: "index.ts:read_graph" },
    "graph.visualize": { implemented: false, reason: "MCP returns data only; visualization is client-side" },
    "graph.link_findings": { implemented: true, handler: "index.ts:link_findings" },

    // Config
    "config.get": { implemented: true, handler: "index.ts:get_config (supports all domains including topic)" },
    "config.set": { implemented: true, handler: "index.ts:set_config (proactivity, taskMode, findingSensitivity, retention, workflow, index, topic)" },

    // Health / Sync / Session
    "health.check": { implemented: true, handler: "index.ts:health_check" },
    "health.doctor_fix": { implemented: true, handler: "index.ts:doctor_fix" },
    "health.sync": { implemented: true, handler: "index.ts:push_changes" },
    "session.start": { implemented: true, handler: "index.ts:session_start" },
    "session.end": { implemented: true, handler: "index.ts:session_end" },

    // Skill management
    "skill.list": { implemented: true, handler: "index.ts:list_skills" },
    "skill.read": { implemented: true, handler: "index.ts:read_skill" },
    "skill.enable": { implemented: true, handler: "index.ts:toggle_skill" },
    "skill.write": { implemented: true, handler: "index.ts:write_skill" },

    // Project management
    "project.list": { implemented: true, handler: "index.ts:list_projects" },
    "project.manage": { implemented: true, handler: "index.ts:manage_project" },
    "project.summary": { implemented: true, handler: "index.ts:get_project_summary" },
    "export.project": { implemented: true, handler: "index.ts:export_project" },
    "import.project": { implemented: true, handler: "index.ts:import_project" },

    // Profile / Machine
    "profile.switch": { implemented: false, reason: "No MCP tool for profile switching" },
    "profile.list": { implemented: false, reason: "No MCP tool for profile listing" },
  },
};
