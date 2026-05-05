/**
 * Command registry - single source of truth for help generation and dispatch.
 *
 * Replaces four parallel sources that used to drift:
 *   - HELP_TEXT (cheat sheet)
 *   - HELP_TOPICS (topic-grouped help)
 *   - CLI_COMMANDS (allowlist)
 *   - the if/else dispatch chain in entrypoint.ts and the switch in cli/cli.ts
 *
 * Order in REGISTRY is load-bearing: it drives cheat-sheet ordering and
 * within-topic ordering. Don't sort.
 */

// Native handlers load lazily via `native()` below - statically importing
// cli-handlers.js would pull init/init.js (and its transitive deps) into
// every phren invocation, defeating cold-start.

// ── Types ────────────────────────────────────────────────────────────────────

export const TOPIC_ORDER = [
  "core",
  "projects",
  "skills",
  "hooks",
  "config",
  "maintain",
  "setup",
  "stores",
  "team",
] as const;

export type Topic = typeof TOPIC_ORDER[number];

export interface Subcommand {
  name: string;
  usage: string;
  summary?: string;
}

/**
 * Lazy accessors passed to every `run`. Both throw or resolve only when
 * called, so commands that dispatch without a configured phren root
 * (`verify`, `init`, `add`, the help router) avoid touching them.
 */
export interface CliContext {
  phrenPath: () => string;
  profile: () => string;
}

export type RunFn = (argv: string[], ctx: CliContext) => Promise<number | void>;

export interface Command {
  name: string;
  aliases?: string[];
  topic: Topic;
  /** Full usage line shown in topic help and per-command help. */
  usage: string;
  /** Optional shorter form for the cheat sheet. Falls back to `usage`. */
  cheatUsage?: string;
  summary: string;
  subcommands?: Subcommand[];
  featured?: boolean;
  hidden?: boolean;
  run: RunFn;
}

// ── Native handler dispatch helper ──────────────────────────────────────────

type NativeHandlerName =
  | "runAddCommand"
  | "runInitCommand"
  | "runUninstallCommand"
  | "runStatusCommand"
  | "runVerifyCommand"
  | "runMcpModeCommand"
  | "runHooksModeCommand"
  | "runLinkRemovedNotice";

function native(fn: NativeHandlerName): RunFn {
  return async (args) => {
    const mod = await import("./cli-handlers.js");
    return mod[fn](args);
  };
}

// ── Doc topics (not commands) ────────────────────────────────────────────────

export const ENV_HELP = `Environment variables:
  PHREN_PATH                  Override phren directory (default: ~/.phren)
  PHREN_PROFILE               Active profile name
  PHREN_DEBUG                 Enable debug logging (set to 1)

  Embeddings:
  PHREN_OLLAMA_URL            Ollama base URL (default: http://localhost:11434, 'off' to disable)
  PHREN_EMBEDDING_API_URL     OpenAI-compatible /embeddings endpoint
  PHREN_EMBEDDING_API_KEY     API key for embedding endpoint
  PHREN_EMBEDDING_MODEL       Embedding model (default: nomic-embed-text)

  Context injection:
  PHREN_CONTEXT_TOKEN_BUDGET  Max tokens injected per prompt (default: 550)
  PHREN_MAX_INJECT_TOKENS     Hard cap on total injected tokens (default: 2000)
  PHREN_HOOK_TIMEOUT_MS       Hook subprocess timeout in ms (default: 14000)

  Feature flags:
  PHREN_FEATURE_AUTO_EXTRACT=0       Disable auto memory extraction
  PHREN_FEATURE_AUTO_CAPTURE=1       Extract insights from conversations
  PHREN_FEATURE_SEMANTIC_DEDUP=1     LLM-based dedup on add_finding
  PHREN_FEATURE_HYBRID_SEARCH=0      Disable TF-IDF cosine fallback

  Run 'phren help all' to see everything.
`;

export const DOC_TOPICS: Record<string, string> = {
  env: ENV_HELP,
};

// ── Subcommand catalogues ────────────────────────────────────────────────────
// Lifted from the old HELP_TOPICS string blocks. Verbatim where preserved.

const PROJECTS_SUBCOMMANDS: Subcommand[] = [
  { name: "list", usage: "phren projects list", summary: "List all tracked projects" },
  { name: "configure", usage: "phren projects configure <name> [--ownership <mode>] [--hooks on|off]", summary: "Update per-project settings" },
  { name: "remove", usage: "phren projects remove <name>", summary: "Remove a project" },
];

const SKILLS_SUBCOMMANDS: Subcommand[] = [
  { name: "list", usage: "phren skills list", summary: "List installed skills" },
  { name: "add", usage: "phren skills add <project> <path>", summary: "Link a skill into a project" },
  { name: "show", usage: "phren skills show <name>", summary: "Show skill content" },
  { name: "resolve", usage: "phren skills resolve <project|global>", summary: "Print resolved skill manifest" },
  { name: "doctor", usage: "phren skills doctor <project|global>", summary: "Diagnose skill visibility" },
  { name: "sync", usage: "phren skills sync <project|global>", summary: "Regenerate skill mirror" },
  { name: "enable", usage: "phren skills enable <project|global> <name>", summary: "Enable a disabled skill" },
  { name: "disable", usage: "phren skills disable <project|global> <name>", summary: "Disable a skill without deleting" },
  { name: "remove", usage: "phren skills remove <project> <name>", summary: "Remove a skill" },
];

const HOOKS_SUBCOMMANDS: Subcommand[] = [
  { name: "list", usage: "phren hooks list [--project <name>]", summary: "Show hook status per tool" },
  { name: "enable", usage: "phren hooks enable <tool>", summary: "Enable hooks for a tool" },
  { name: "disable", usage: "phren hooks disable <tool>", summary: "Disable hooks for a tool" },
  { name: "add-custom", usage: "phren hooks add-custom <event> <cmd>", summary: "Add a custom hook" },
  { name: "remove-custom", usage: "phren hooks remove-custom <event>", summary: "Remove custom hooks" },
  { name: "errors", usage: "phren hooks errors [--limit <n>]", summary: "Show recent hook errors" },
];

const CONFIG_SUBCOMMANDS: Subcommand[] = [
  { name: "show", usage: "phren config show [--project <name>]", summary: "Show current config" },
  { name: "policy", usage: "phren config policy [get|set ...]", summary: "Retention, TTL, confidence, decay" },
  { name: "workflow", usage: "phren config workflow [get|set ...]", summary: "Risky-memory thresholds" },
  { name: "proactivity", usage: "phren config proactivity [level]", summary: "Set proactivity level" },
  { name: "task-mode", usage: "phren config task-mode [mode]", summary: "Set task automation mode" },
  { name: "finding-sensitivity", usage: "phren config finding-sensitivity [lvl]", summary: "Set finding capture sensitivity" },
  { name: "index", usage: "phren config index [get|set ...]", summary: "Indexer include/exclude globs" },
  { name: "synonyms", usage: "phren config synonyms [list|add|remove]", summary: "Manage learned synonyms" },
  { name: "project-ownership", usage: "phren config project-ownership [mode]", summary: "Default ownership for new projects" },
  { name: "machines", usage: "phren config machines", summary: "Registered machines" },
  { name: "profiles", usage: "phren config profiles", summary: "Profiles and projects" },
  { name: "telemetry", usage: "phren config telemetry [on|off]", summary: "Opt-in usage telemetry" },
];

const MAINTAIN_SUBCOMMANDS: Subcommand[] = [
  { name: "govern", usage: "phren maintain govern [project]", summary: "Queue stale memories for review" },
  { name: "prune", usage: "phren maintain prune [project]", summary: "Delete expired entries" },
  { name: "consolidate", usage: "phren maintain consolidate [project]", summary: "Deduplicate findings" },
  { name: "extract", usage: "phren maintain extract [project]", summary: "Mine git/GitHub signals" },
];

const STORE_SUBCOMMANDS: Subcommand[] = [
  { name: "list", usage: "phren store list", summary: "List registered stores" },
  { name: "add", usage: "phren store add <name> --remote <url>", summary: "Add a team store" },
  { name: "remove", usage: "phren store remove <name>", summary: "Remove a store (local only)" },
  { name: "sync", usage: "phren store sync", summary: "Pull all stores" },
];

const TEAM_SUBCOMMANDS: Subcommand[] = [
  { name: "init", usage: "phren team init <name> [--remote <url>]", summary: "Create a new team store" },
  { name: "join", usage: "phren team join <git-url> [--name <name>]", summary: "Join an existing team store" },
  { name: "add-project", usage: "phren team add-project <store> <project>", summary: "Add a project to a team store" },
  { name: "list", usage: "phren team list", summary: "List team stores" },
];

// ── Registry ─────────────────────────────────────────────────────────────────

export const REGISTRY: Command[] = [
  // Setup (featured: init, quickstart)
  {
    name: "init",
    topic: "setup",
    usage: "phren init [--mode shared|project-local] [--machine <n>] [--profile <n>] [--dry-run] [-y]",
    cheatUsage: "phren init",
    summary: "Set up phren",
    featured: true,
    run: native("runInitCommand"),
  },
  {
    name: "quickstart",
    topic: "setup",
    usage: "phren quickstart",
    summary: "Quick setup: init + project scaffold",
    featured: true,
    run: async () => {
      const { handleQuickstart } = await import("./cli/ops.js");
      await handleQuickstart();
    },
  },

  // Projects (featured: add)
  {
    name: "add",
    topic: "projects",
    usage: "phren add [path] [--ownership <mode>]",
    summary: "Register a project",
    featured: true,
    run: native("runAddCommand"),
  },
  {
    name: "projects",
    topic: "projects",
    usage: "phren projects <subcommand>",
    summary: "Manage tracked projects",
    subcommands: PROJECTS_SUBCOMMANDS,
    run: async (args, ctx) => {
      const { handleProjectsNamespace } = await import("./cli/namespaces.js");
      await handleProjectsNamespace(args, ctx.profile());
    },
  },

  // Core (featured: search, status, doctor, web-ui, tasks, graph, shell)
  {
    name: "search",
    topic: "core",
    usage: "phren search <query>",
    summary: "Search what phren knows",
    featured: true,
    run: async (args, ctx) => {
      const { parseSearchArgs } = await import("./cli/search.js");
      const { handleSearch } = await import("./cli/actions.js");
      const opts = parseSearchArgs(ctx.phrenPath(), args);
      if (!opts) return;
      await handleSearch(opts, ctx.profile());
    },
  },
  {
    name: "status",
    topic: "core",
    usage: "phren status",
    summary: "Health check",
    featured: true,
    run: native("runStatusCommand"),
  },
  {
    name: "doctor",
    topic: "core",
    usage: "phren doctor [--fix]",
    summary: "Diagnose and repair",
    featured: true,
    run: async (args) => {
      const { handleDoctor } = await import("./cli/actions.js");
      await handleDoctor(args);
    },
  },
  {
    name: "web-ui",
    topic: "core",
    usage: "phren web-ui [--port <n>]",
    summary: "Open the knowledge graph",
    featured: true,
    run: async (args) => {
      const { handleMemoryUi } = await import("./cli/actions.js");
      await handleMemoryUi(args);
    },
  },
  {
    name: "tasks",
    topic: "core",
    usage: "phren tasks",
    summary: "Cross-project task view",
    featured: true,
    run: async (_args, ctx) => {
      const { handleTaskView } = await import("./cli/ops.js");
      await handleTaskView(ctx.profile());
    },
  },
  {
    name: "graph",
    topic: "core",
    usage: "phren graph",
    summary: "Fragment knowledge graph",
    featured: true,
    run: async (args) => {
      const { handleGraphNamespace } = await import("./cli/graph.js");
      await handleGraphNamespace(args);
    },
  },
  {
    name: "shell",
    topic: "core",
    usage: "phren shell",
    summary: "Interactive memory shell",
    featured: true,
    run: async (args, ctx) => {
      const { handleShell } = await import("./cli/actions.js");
      await handleShell(args, ctx.profile());
    },
  },

  // Other core commands
  {
    name: "add-finding",
    topic: "core",
    usage: 'phren add-finding <project> "<insight>"',
    summary: "Tell phren what you learned",
    run: async (args) => {
      const { handleAddFinding } = await import("./cli/actions.js");
      await handleAddFinding(args[0], args.slice(1).join(" "));
    },
  },
  {
    name: "pin",
    topic: "core",
    usage: 'phren pin <project> "<truth>"',
    summary: "Save a truth (always-inject, never decays)",
    run: async (args) => {
      const { handlePinCanonical } = await import("./cli/actions.js");
      await handlePinCanonical(args[0], args.slice(1).join(" "));
    },
  },
  {
    name: "review",
    topic: "core",
    usage: "phren review [project]",
    summary: "Show review queue",
    run: async (args) => {
      const { handleReviewNamespace } = await import("./cli/namespaces.js");
      await handleReviewNamespace(args);
    },
  },
  {
    name: "session-context",
    topic: "core",
    usage: "phren session-context",
    summary: "Current session state",
    run: async () => {
      const { handleSessionContext } = await import("./cli/actions.js");
      await handleSessionContext();
    },
  },
  {
    name: "sessions",
    topic: "core",
    usage: "phren sessions",
    summary: "List recent sessions",
    run: async (args) => {
      const { handleSessionsView } = await import("./cli/ops.js");
      await handleSessionsView(args);
    },
  },
  {
    name: "task",
    topic: "core",
    usage: "phren task <subcommand>",
    summary: "Manage tasks",
    run: async (args) => {
      const { handleTaskNamespace } = await import("./cli/namespaces.js");
      await handleTaskNamespace(args);
    },
  },
  {
    name: "finding",
    topic: "core",
    usage: "phren finding <subcommand>",
    summary: "Manage findings",
    run: async (args) => {
      const { handleFindingNamespace } = await import("./cli/namespaces.js");
      await handleFindingNamespace(args);
    },
  },
  {
    name: "search-fragments",
    topic: "core",
    usage: "phren search-fragments <query>",
    summary: "Search the named-fragment graph",
    run: async (args, ctx) => {
      const { handleFragmentSearch } = await import("./cli/actions.js");
      await handleFragmentSearch(args, ctx.profile());
    },
  },
  {
    name: "related-docs",
    topic: "core",
    usage: "phren related-docs <entity>",
    summary: "Find docs that share fragments with an entity",
    run: async (args, ctx) => {
      const { handleRelatedDocs } = await import("./cli/actions.js");
      await handleRelatedDocs(args, ctx.profile());
    },
  },
  {
    name: "truths",
    topic: "core",
    usage: "phren truths [project]",
    summary: "Show pinned truths for a project",
    run: async (args) => {
      const { handleTruths } = await import("./cli/actions.js");
      await handleTruths(args[0]);
    },
  },
  {
    name: "promote",
    topic: "core",
    usage: "phren promote <finding> --to <store>",
    summary: "Move a finding from personal to a team store",
    run: async (args) => {
      const { handlePromoteNamespace } = await import("./cli/namespaces.js");
      await handlePromoteNamespace(args);
    },
  },

  // Skills
  {
    name: "skills",
    topic: "skills",
    usage: "phren skills <subcommand>",
    summary: "Manage skills",
    subcommands: SKILLS_SUBCOMMANDS,
    run: async (args, ctx) => {
      const { handleSkillsNamespace } = await import("./cli/namespaces.js");
      await handleSkillsNamespace(args, ctx.profile());
    },
  },
  {
    name: "detect-skills",
    topic: "skills",
    usage: "phren detect-skills [--import]",
    summary: "Find untracked skills in ~/.claude/skills/",
    run: async (args, ctx) => {
      const { handleDetectSkills } = await import("./cli/namespaces.js");
      await handleDetectSkills(args, ctx.profile());
    },
  },

  // Hooks (namespace shares name with topic - distinct concept)
  {
    name: "hooks",
    topic: "hooks",
    usage: "phren hooks <subcommand>",
    summary: "Manage lifecycle hooks",
    subcommands: HOOKS_SUBCOMMANDS,
    run: async (args) => {
      const { handleHooksNamespace } = await import("./cli/namespaces.js");
      await handleHooksNamespace(args);
    },
  },

  // Config
  {
    name: "config",
    topic: "config",
    usage: "phren config <subcommand>",
    summary: "View and update configuration",
    subcommands: CONFIG_SUBCOMMANDS,
    run: async (args) => {
      const { handleConfig } = await import("./cli/config.js");
      await handleConfig(args);
    },
  },

  // Maintain
  {
    name: "maintain",
    topic: "maintain",
    usage: "phren maintain <subcommand>",
    summary: "Memory maintenance operations",
    subcommands: MAINTAIN_SUBCOMMANDS,
    run: async (args) => {
      const { handleMaintain } = await import("./cli/govern.js");
      await handleMaintain(args);
    },
  },
  {
    name: "consolidation-status",
    topic: "maintain",
    usage: "phren consolidation-status",
    summary: "Report findings consolidation health",
    run: async (args) => {
      const { handleConsolidationStatus } = await import("./cli/actions.js");
      await handleConsolidationStatus(args);
    },
  },
  {
    name: "quality-feedback",
    topic: "maintain",
    usage: "phren quality-feedback",
    summary: "Inspect injected-memory feedback",
    run: async (args) => {
      const { handleQualityFeedback } = await import("./cli/actions.js");
      await handleQualityFeedback(args);
    },
  },

  // Setup (the rest)
  {
    name: "mcp-mode",
    topic: "setup",
    usage: "phren mcp-mode [on|off|status]",
    summary: "Toggle MCP integration",
    run: native("runMcpModeCommand"),
  },
  {
    name: "hooks-mode",
    topic: "setup",
    usage: "phren hooks-mode [on|off|status]",
    summary: "Toggle hook execution",
    run: native("runHooksModeCommand"),
  },
  {
    name: "verify",
    topic: "setup",
    usage: "phren verify",
    summary: "Check init completed OK",
    run: native("runVerifyCommand"),
  },
  {
    name: "uninstall",
    topic: "setup",
    usage: "phren uninstall",
    summary: "Remove phren config and hooks",
    run: native("runUninstallCommand"),
  },
  {
    name: "update",
    topic: "setup",
    usage: "phren update [--refresh-starter]",
    summary: "Update to latest version",
    run: async (args) => {
      const { handleUpdate } = await import("./cli/actions.js");
      await handleUpdate(args);
    },
  },
  {
    name: "profile",
    topic: "setup",
    usage: "phren profile <subcommand>",
    summary: "Manage machine-to-profile mappings",
    run: async (args) => {
      const { handleProfileNamespace } = await import("./cli/namespaces.js");
      await handleProfileNamespace(args);
    },
  },

  // Stores
  {
    name: "store",
    topic: "stores",
    usage: "phren store <subcommand>",
    summary: "Manage knowledge stores",
    subcommands: STORE_SUBCOMMANDS,
    run: async (args) => {
      const { handleStoreNamespace } = await import("./cli/namespaces.js");
      await handleStoreNamespace(args);
    },
  },

  // Team
  {
    name: "team",
    topic: "team",
    usage: "phren team <subcommand>",
    summary: "Manage team stores",
    subcommands: TEAM_SUBCOMMANDS,
    run: async (args) => {
      const { handleTeamNamespace } = await import("./cli/team.js");
      await handleTeamNamespace(args);
    },
  },

  // Hidden - internal hooks (called by Claude/Cursor/etc., not by humans)
  {
    name: "hook-prompt",
    topic: "core",
    usage: "phren hook-prompt",
    summary: "Internal: UserPromptSubmit hook",
    hidden: true,
    run: async () => {
      const { handleHookPrompt } = await import("./cli/hooks.js");
      await handleHookPrompt();
    },
  },
  {
    name: "hook-session-start",
    topic: "core",
    usage: "phren hook-session-start",
    summary: "Internal: SessionStart hook",
    hidden: true,
    run: async () => {
      const { handleHookSessionStart } = await import("./cli/hooks.js");
      await handleHookSessionStart();
    },
  },
  {
    name: "hook-stop",
    topic: "core",
    usage: "phren hook-stop",
    summary: "Internal: Stop hook",
    hidden: true,
    run: async () => {
      const { handleHookStop } = await import("./cli/hooks.js");
      await handleHookStop();
    },
  },
  {
    name: "hook-context",
    topic: "core",
    usage: "phren hook-context",
    summary: "Internal: context-injection hook",
    hidden: true,
    run: async () => {
      const { handleHookContext } = await import("./cli/hooks.js");
      await handleHookContext();
    },
  },
  {
    name: "hook-tool",
    topic: "core",
    usage: "phren hook-tool",
    summary: "Internal: PostToolUse hook",
    hidden: true,
    run: async () => {
      const { handleHookTool } = await import("./cli/hooks.js");
      await handleHookTool();
    },
  },
  {
    name: "background-sync",
    topic: "core",
    usage: "phren background-sync",
    summary: "Internal: background git sync",
    hidden: true,
    run: async () => {
      const { handleBackgroundSync } = await import("./cli/hooks.js");
      await handleBackgroundSync();
    },
  },
  {
    name: "background-maintenance",
    topic: "core",
    usage: "phren background-maintenance",
    summary: "Internal: scheduled maintenance",
    hidden: true,
    run: async (args) => {
      const { handleBackgroundMaintenance } = await import("./cli/govern.js");
      await handleBackgroundMaintenance(args[0]);
    },
  },
  {
    name: "debug-injection",
    topic: "core",
    usage: "phren debug-injection",
    summary: "Internal: dump injection rationale",
    hidden: true,
    run: async (args, ctx) => {
      const { handleDebugInjection } = await import("./cli/ops.js");
      await handleDebugInjection(args, ctx.profile());
    },
  },
  {
    name: "inspect-index",
    topic: "core",
    usage: "phren inspect-index",
    summary: "Internal: dump index contents",
    hidden: true,
    run: async (args, ctx) => {
      const { handleInspectIndex } = await import("./cli/ops.js");
      await handleInspectIndex(args, ctx.profile());
    },
  },

  // Hidden - undocumented aliases of namespaced commands (kept for back-compat;
  // user-facing form lives under config / maintain / skills).
  {
    name: "skill-list",
    topic: "skills",
    usage: "phren skill-list",
    summary: "Alias of `phren skills list`",
    hidden: true,
    run: async (_args, ctx) => {
      const { handleSkillList } = await import("./cli/namespaces.js");
      await handleSkillList(ctx.profile());
    },
  },
  {
    name: "policy",
    topic: "config",
    usage: "phren policy [get|set ...]",
    summary: "Alias of `phren config policy`",
    hidden: true,
    run: async (args) => {
      const { handleRetentionPolicy } = await import("./cli/config.js");
      await handleRetentionPolicy(args);
    },
  },
  {
    name: "workflow",
    topic: "config",
    usage: "phren workflow [get|set ...]",
    summary: "Alias of `phren config workflow`",
    hidden: true,
    run: async (args) => {
      const { handleWorkflowPolicy } = await import("./cli/config.js");
      await handleWorkflowPolicy(args);
    },
  },
  {
    name: "index-policy",
    topic: "config",
    usage: "phren index-policy [...]",
    summary: "Alias of `phren config index`",
    hidden: true,
    run: async (args) => {
      const { handleIndexPolicy } = await import("./cli/config.js");
      await handleIndexPolicy(args);
    },
  },
  {
    name: "extract-memories",
    topic: "maintain",
    usage: "phren extract-memories [project]",
    summary: "Alias of `phren maintain extract`",
    hidden: true,
    run: async (args) => {
      const { handleExtractMemories } = await import("./cli/extract.js");
      await handleExtractMemories(args[0]);
    },
  },
  {
    name: "govern-memories",
    topic: "maintain",
    usage: "phren govern-memories [project]",
    summary: "Alias of `phren maintain govern`",
    hidden: true,
    run: async (args) => {
      const { handleGovernMemories } = await import("./cli/govern.js");
      await handleGovernMemories(args[0]);
    },
  },
  {
    name: "prune-memories",
    topic: "maintain",
    usage: "phren prune-memories [project]",
    summary: "Alias of `phren maintain prune`",
    hidden: true,
    run: async (args) => {
      const { handlePruneMemories } = await import("./cli/govern.js");
      await handlePruneMemories(args);
    },
  },
  {
    name: "consolidate-memories",
    topic: "maintain",
    usage: "phren consolidate-memories [project]",
    summary: "Alias of `phren maintain consolidate`",
    hidden: true,
    run: async (args) => {
      const { handleConsolidateMemories } = await import("./cli/govern.js");
      await handleConsolidateMemories(args);
    },
  },

  // Hidden - `phren link` was removed; this prints a removal notice.
  {
    name: "link",
    topic: "setup",
    usage: "phren link",
    summary: "Removed - use `phren init`",
    hidden: true,
    run: native("runLinkRemovedNotice"),
  },
];

// ── Lookup ───────────────────────────────────────────────────────────────────

export function lookupCommand(name: string): Command | undefined {
  for (const cmd of REGISTRY) {
    if (cmd.name === name) return cmd;
    if (cmd.aliases?.includes(name)) return cmd;
  }
  return undefined;
}

/** Topic IDs available to `phren help <topic>`, including doc topics and `all`. */
export function helpTopicNames(): string[] {
  return [...TOPIC_ORDER, ...Object.keys(DOC_TOPICS), "all"];
}

/** Topic IDs that are command groups (excludes doc topics and `all`). */
export function commandTopics(): readonly Topic[] {
  return TOPIC_ORDER;
}
