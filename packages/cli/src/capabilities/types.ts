export const ACTION_KEYS = [
  // Finding management
  "finding.add",
  "finding.remove",
  "finding.list",
  "finding.filter_by_date",
  "finding.pin",

  // Task management
  "task.add",
  "task.complete",
  "task.remove",
  "task.update",
  "task.list",
  "task.pin",
  "task.github_link",

  // Hook management
  "hook.list",
  "hook.toggle",
  "hook.toggle_per_project",
  "hook.custom_crud",
  "hook.errors",

  // Search
  "search.fts",
  "search.fragment",
  "search.related_docs",
  "search.history",

  // Graph
  "graph.read",
  "graph.visualize",
  "graph.link_findings",

  // Config
  "config.get",
  "config.set",

  // Health / Sync / Session
  "health.check",
  "health.doctor_fix",
  "health.sync",
  "session.start",
  "session.end",

  // Skill management
  "skill.list",
  "skill.read",
  "skill.enable",
  "skill.write",

  // Project management
  "project.list",
  "project.manage",
  "project.summary",
  "export.project",
  "import.project",

  // Profile / Machine
  "profile.switch",
  "profile.list",
] as const;

export type ActionKey = typeof ACTION_KEYS[number];

export interface CapabilityEntry {
  implemented: boolean;
  handler?: string;
  reason?: string;
}

export interface CapabilityManifest {
  surface: "cli" | "mcp" | "vscode" | "web-ui";
  version: string;
  actions: Record<ActionKey, CapabilityEntry>;
}
