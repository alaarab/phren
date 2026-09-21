import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { z } from "zod";
import { VERSION } from "../package-metadata.js";
import type { ModuleManifest, ModuleRoute, ModuleTool, ModulesConfig } from "./manifest.js";

const core = (names: string[]): ModuleTool[] => names.map(name => ({ name, profiles: ["core", "full"] }));
const full = (names: string[]): ModuleTool[] => names.map(name => ({ name, profiles: ["full"] }));
const routes = (method: ModuleRoute["method"], paths: string[]): ModuleRoute[] => paths.map(path => ({ method, path }));

export const BUILTIN_MODULES: readonly ModuleManifest[] = [
  {
    schemaVersion: 1, name: "memory", version: VERSION, defaultEnabled: true, requires: [],
    tools: [
      ...core(["search_knowledge", "get_memory_detail", "get_project_summary", "add_finding", "revise_finding", "session", "phren_admin"]),
      ...full([
        "list_projects", "get_findings", "store_list", "supersede_finding", "retract_finding",
        "resolve_contradiction", "get_contradictions", "edit_finding", "remove_finding", "push_changes",
        "pin_memory", "get_truths", "memory_feedback", "export_project", "import_project", "manage_project",
        "search_fragments", "get_related_docs", "read_graph", "link_findings", "cross_project_fragments",
        "session_start", "session_end", "session_context", "session_history",
        "add_project", "health_check", "doctor_fix", "list_hook_errors", "get_review_queue", "manage_review_item",
        "list_skills", "read_skill", "write_skill", "remove_skill", "toggle_skill",
        "list_hooks", "toggle_hooks", "add_custom_hook", "remove_custom_hook", "get_config", "set_config",
        "get_notes", "add_note", "edit_note", "remove_note", "promote_note", "get_topic_summaries", "set_topic_summary",
      ]),
    ],
    cliCommands: [
      "init", "quickstart", "add", "projects", "search", "status", "doctor", "web-ui", "graph", "shell",
      "add-finding", "pin", "review", "session-context", "sessions", "finding", "note", "notes",
      "search-fragments", "related-docs", "truths", "promote", "skills", "detect-skills", "hooks", "config",
      "maintain", "consolidation-status", "quality-feedback", "mcp-mode", "hooks-mode", "preset", "snippet",
      "verify", "uninstall", "update", "profile", "store", "team", "modules list", "modules enable", "modules disable",
      "hook-prompt", "hook-session-start", "hook-stop", "hook-context", "hook-tool", "background-sync",
      "background-maintenance", "background-reindex", "debug-injection", "inspect-index", "skill-list",
      "policy", "workflow", "index-policy", "govern-memories", "prune-memories", "consolidate-memories", "link",
    ],
    agentHooks: [
      { agents: ["claude", "codex", "copilot", "cursor"], events: ["SessionStart"], handler: "phren hook-session-start" },
      { agents: ["claude", "codex", "copilot", "cursor"], events: ["UserPromptSubmit"], handler: "phren hook-prompt" },
      { agents: ["claude", "codex", "copilot", "cursor"], events: ["Stop"], handler: "phren hook-stop" },
      { agents: ["claude"], events: ["PostToolUse"], handler: "phren hook-tool" },
    ],
    hookRoutes: [], capabilities: ["memory"],
    storeFiles: [
      "phren.root.yaml", "machines.yaml", "profiles/*.yaml", ".config/modules.yaml", ".config/*.json",
      "<project>/AGENTS.md", "<project>/summary.md", "<project>/FINDINGS.md", "<project>/truths.md",
      "<project>/review.md", "<project>/notes/*.md", "<project>/reference/**", "<project>/skills/**",
      "<project>/phren.project.yaml", "<project>/preferences.json", ".runtime/sessions/session-*.json",
      ".runtime/sessions/last-summary.json",
    ],
    localFiles: [],
    phoneScreens: [{ screen: "ProjectsView", capability: "memory" }, { screen: "SearchView", capability: "memory" }],
    skills: ["phren-init", "phren-sync", "phren-profiles", "phren-discover", "phren-consolidate", "phren-summarize"],
  },
  {
    schemaVersion: 1, name: "tasks", version: VERSION, defaultEnabled: true, requires: ["memory"],
    tools: [
      ...core(["get_tasks", "add_task", "manage_task"]),
      ...full(["complete_task", "remove_task", "update_task", "tidy_done_tasks", "pin_task"]),
    ],
    cliCommands: ["task", "tasks", "config task-mode", "config proactivity.tasks"], agentHooks: [], hookRoutes: [], capabilities: ["tasks"],
    storeFiles: ["<project>/tasks.md", ".sessions/checkpoint-*.json"], localFiles: [],
    phoneScreens: [{ screen: "TasksView", capability: "tasks" }], skills: [],
  },
  {
    schemaVersion: 1, name: "hook", version: VERSION, defaultEnabled: false, requires: ["memory"],
    tools: [],
    cliCommands: [
      "bridge", "bridge install", "bridge update", "bridge uninstall", "bridge rollback", "bridge status",
      "bridge doctor", "bridge usage", "bridge usage-statusline", "bridge hook", "bridge serve", "bridge ssh",
    ],
    agentHooks: [
      { agents: ["codex", "claude"], events: ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"], handler: "bridge-hook.mjs hook <agent>" },
      { agents: ["claude"], events: ["PreCompact"], handler: "bridge-hook.mjs hook claude" },
      { agents: ["copilot"], events: ["SessionStart", "UserPromptSubmit"], handler: "bridge-hook.mjs hook copilot" },
    ],
    hookRoutes: [
      ...routes("GET", [
        "/v1/health", "/v1/muxes", "/v1/activity", "/v1/web-servers", "/v1/simulators",
        "/v1/simulators/screenshot", "/v1/simulators/apps", "/v1/files", "/v1/models", "/v1/projects/files",
        "/v1/uploads/image", "/v1/usage", "/v1/push/status", "/v1/projects/locate", "/v1/projects/repos",
        "/v1/workspaces", "/v1/workspaces/panes", "/v1/transcripts/blob", "/v1/transcripts/history",
        "/v1/subagents", "/v1/subagents/transcript",
      ]),
      ...routes("POST", [
        "/v1/push/register", "/v1/push/answer", "/v1/files", "/v1/projects/add", "/v1/simulators/action",
        "/v1/workspaces/launch", "/v1/workspaces/create", "/v1/workspaces/focus", "/v1/workspaces/rename",
        "/v1/workspaces/close", "/v1/prompt", "/v1/keys", "/v1/secret", "/v1/upload",
        "/v1/approvals/answer", "/v1/questions/answer",
      ]),
      ...routes("WS", ["/v1/transcripts", "/v1/status"]),
    ],
    capabilities: [
      "hook", "transcript", "progress", "images", "prompt", "stop", "terminal", "shell", "herdr",
      "webServers", "webPreview", "activity", "approvals", "questions", "accountUsage", "providers",
      "files", "repositoryFiles", "subagents", "approvalPush", "simulators",
    ],
    storeFiles: [".runtime/sessions/opencode-*.events.jsonl", ".runtime/approvals/opencode-*.json"],
    localFiles: ["<bridge>/installed.json", "<bridge>/versions/**", "<bridge>/current", "<bridge>/dispatch", "<bridge>/computer-id"],
    phoneScreens: [{ screen: "LiveSessionsView", capability: "hook" }, { screen: "AgentChatView", capability: "transcript" }],
    skills: [],
  },
  {
    schemaVersion: 1, name: "git", version: VERSION, defaultEnabled: false, requires: ["memory"],
    tools: full(["auto_extract_findings"]), cliCommands: ["maintain extract", "extract-memories"],
    agentHooks: [
      { agents: ["codex", "claude"], events: ["PreToolUse", "PostToolUse"], handler: "bridge-hook.mjs hook <agent>" },
    ],
    hookRoutes: routes("POST", [
      "/v1/diff", "/v1/git/status", "/v1/git/log", "/v1/git/branches", "/v1/git/pulls",
      "/v1/git/tree", "/v1/git/stage", "/v1/git/unstage", "/v1/git/discard",
    ]),
    capabilities: ["git", "diff"], storeFiles: [], localFiles: ["<bridge>/changes/**", "<bridge>/changes-scratch/**"],
    phoneScreens: [{ screen: "AgentChangesView", capability: "git" }], skills: [],
  },
  {
    schemaVersion: 1, name: "schedules", version: VERSION, defaultEnabled: false, requires: ["memory"],
    tools: [], cliCommands: ["schedule"], agentHooks: [],
    hookRoutes: routes("POST", ["/v1/schedules", "/v1/schedules/run", "/v1/schedules/history"]),
    capabilities: ["schedules"], storeFiles: ["<project>/schedules.yaml", ".runtime/agent-fanouts/<run-id>/**"],
    localFiles: ["<bridge>/schedule-runs.jsonl"],
    phoneScreens: [{ screen: "SchedulesView", capability: "schedules" }], skills: [],
  },
  {
    schemaVersion: 1, name: "conductor", version: VERSION, defaultEnabled: false, requires: ["memory", "hook"],
    tools: full(["dispatch", "hand_off"]), cliCommands: ["dispatch", "dispatch status", "hand-off", "bridge enroll-computer"], agentHooks: [],
    hookRoutes: [...routes("GET", ["/v1/dispatch", "/v1/dispatch/capacity"]), ...routes("POST", ["/v1/dispatch"])],
    capabilities: ["dispatch"], storeFiles: ["global/skills/conductor/**"],
    localFiles: ["<bridge>/hooks.yaml", "<bridge>/dispatches/*.json"], phoneScreens: [], skills: ["conductor"],
  },
  {
    // Stage 1 shipped the local indexer and store; stage 2 the five read tools,
    // the matching CLI subcommands and the code skill; stage 3 the Hook routes,
    // the change-driven re-index and the phone's Code screen.
    schemaVersion: 1, name: "code", version: VERSION, defaultEnabled: false, requires: ["memory"],
    tools: full(["code_search", "code_definition", "code_references", "code_outline", "code_usage"]),
    cliCommands: ["code index", "code status", "code search", "code outline", "code refs", "code def", "code usage"],
    agentHooks: [],
    hookRoutes: routes("GET", ["/v1/code/status", "/v1/code/search", "/v1/code/outline", "/v1/code/definition", "/v1/code/references", "/v1/code/usage"]),
    capabilities: ["code"],
    storeFiles: [], localFiles: ["<store>/.runtime/code/*.sqlite"],
    phoneScreens: [{ screen: "CodeView", capability: "code" }], skills: ["code"],
  },
];

const overrides = z.record(z.string(), z.boolean());
const configSchema = z.object({
  version: z.literal(1),
  enabled: overrides.optional(),
  profiles: z.record(z.string(), z.object({ enabled: overrides.optional() }).strict()).optional(),
}).strict();

export function readConfig(store: string): ModulesConfig | undefined {
  let source: string;
  try { source = fs.readFileSync(path.join(store, ".config", "modules.yaml"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read .config/modules.yaml.");
  }
  let config: ModulesConfig;
  try { config = configSchema.parse(yaml.load(source, { schema: yaml.CORE_SCHEMA })); }
  catch { throw new Error("Invalid .config/modules.yaml: expected version: 1 and boolean module overrides."); }
  return validateConfig(config, true);
}

/** Warned once per process so serve's migrate-then-snapshot double read stays one line. */
const warnedUnknownModules = new Set<string>();

/**
 * Unknown keys belong to a newer CLI that enabled a module this build (the
 * Hook) does not know; they are ignored, kept for writes, and warned about
 * once instead of failing every Hook connection.
 */
export function validateConfig(input: unknown, warnUnknown = false): ModulesConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid .config/modules.yaml: expected version: 1 and boolean module overrides.");
  const config = parsed.data;
  const names = new Set(BUILTIN_MODULES.map(module => module.name));
  const unknown = new Set<string>();
  for (const values of [config.enabled, ...Object.values(config.profiles ?? {}).map(profile => profile.enabled)]) {
    for (const [name, value] of Object.entries(values ?? {})) {
      if (!names.has(name)) { unknown.add(name); continue; }
      if (name === "memory" && !value) throw new Error("The memory module cannot be disabled.");
    }
  }
  for (const name of unknown) {
    if (!warnUnknown || warnedUnknownModules.has(name)) continue;
    warnedUnknownModules.add(name);
    console.error(`warning: unknown module "${name}" in .config/modules.yaml ignored by Hook ${VERSION}`);
  }
  return config;
}

/** Reads never mutate configuration or enable dependencies implicitly. */
export function enabled(store: string, profile?: string): readonly ModuleManifest[] {
  return resolveModules(readConfig(store), profile);
}

export function resolveModules(config: ModulesConfig | undefined, profile?: string): readonly ModuleManifest[] {
  const selected = profile && config?.profiles && Object.hasOwn(config.profiles, profile) ? config.profiles[profile].enabled : undefined;
  const modules = BUILTIN_MODULES.filter(module => selected?.[module.name] ?? config?.enabled?.[module.name] ?? module.defaultEnabled);
  const names = new Set(modules.map(module => module.name));
  for (const module of modules) {
    for (const dependency of module.requires) {
      if (!names.has(dependency)) throw new Error(`Module "${module.name}" requires enabled module "${dependency}".`);
    }
  }
  return modules;
}

export function moduleSource(config: ModulesConfig | undefined, name: string, profile?: string): "default" | "store" | "profile" {
  if (profile && Object.hasOwn(config?.profiles ?? {}, profile) && Object.hasOwn(config?.profiles?.[profile].enabled ?? {}, name)) return "profile";
  return Object.hasOwn(config?.enabled ?? {}, name) ? "store" : "default";
}

export function toolOwner(name: string): ModuleManifest | undefined {
  return BUILTIN_MODULES.find(module => module.tools.some(tool => tool.name === name));
}

export function commandOwner(command: string): ModuleManifest | undefined {
  command = command.toLowerCase();
  let owner: ModuleManifest | undefined;
  let length = 0;
  for (const module of BUILTIN_MODULES) for (const entry of module.cliCommands) {
    if ((command === entry || command.startsWith(entry + " ")) && entry.length > length) { owner = module; length = entry.length; }
  }
  return owner;
}

export function disabledHint(name: string): string {
  return `module ${name} is disabled; enable it with phren modules enable ${name}`;
}
