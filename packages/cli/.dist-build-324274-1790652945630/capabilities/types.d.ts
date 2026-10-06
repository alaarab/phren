export declare const ACTION_KEYS: readonly ["finding.add", "finding.remove", "finding.list", "finding.filter_by_date", "finding.pin", "task.add", "task.complete", "task.remove", "task.update", "task.list", "task.pin", "task.github_link", "hook.list", "hook.toggle", "hook.toggle_per_project", "hook.custom_crud", "hook.errors", "search.fts", "search.fragment", "search.related_docs", "search.history", "graph.read", "graph.visualize", "graph.link_findings", "config.get", "config.set", "health.check", "health.doctor_fix", "health.sync", "session.start", "session.end", "skill.list", "skill.read", "skill.enable", "skill.write", "project.list", "project.manage", "project.summary", "export.project", "import.project", "profile.switch", "profile.list"];
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
