import type { ModuleSnapshot } from "./modules/runtime.js";
/**
 * Command registry - single source of truth for help generation and dispatch.
 *
 * Order in REGISTRY is load-bearing: it drives cheat-sheet ordering and
 * within-topic ordering. Don't sort.
 */
export declare const TOPIC_ORDER: readonly ["core", "projects", "skills", "hooks", "config", "maintain", "setup", "stores", "team"];
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
    /** Runs without a Phren store: dispatch never finds, activates or tracks one. */
    standalone?: boolean;
    run: RunFn;
}
export declare const ENV_HELP = "Environment variables:\n  PHREN_PATH                  Override phren directory (default: ~/.phren)\n  PHREN_PROFILE               Active profile name\n  PHREN_DEBUG                 Enable debug logging (set to 1)\n  PHREN_PULL_INTERVAL_SECONDS Remote check interval in seconds (default: off; 0 disables)\n\n  Embeddings:\n  PHREN_OLLAMA_URL            Ollama base URL (default: http://localhost:11434, 'off' to disable)\n  PHREN_EMBEDDING_API_URL     OpenAI-compatible /embeddings endpoint\n  PHREN_EMBEDDING_API_KEY     API key for embedding endpoint\n  PHREN_EMBEDDING_MODEL       Embedding model (default: nomic-embed-text)\n\n  Context injection:\n  PHREN_CONTEXT_TOKEN_BUDGET  Max tokens injected per prompt (default: 550)\n  PHREN_MAX_INJECT_TOKENS     Hard cap on total injected tokens (default: 2000)\n  PHREN_HOOK_TIMEOUT_MS       Hook subprocess timeout in ms (default: 14000)\n\n  Feature flags:\n  PHREN_FEATURE_AGENTS=1             Show running coding agents on the graph\n  PHREN_FEATURE_TOOL_HOOK=0          Skip the PostToolUse subprocess (perf)\n  PHREN_FEATURE_AUTO_EXTRACT=0       Disable auto memory extraction\n  PHREN_FEATURE_AUTO_CAPTURE=1       Extract insights from conversations\n  PHREN_FEATURE_SEMANTIC_DEDUP=1     LLM-based dedup on add_finding\n  PHREN_FEATURE_HYBRID_SEARCH=0      Disable TF-IDF cosine fallback\n\n  Run 'phren help all' to see everything.\n";
export declare const DOC_TOPICS: Record<string, string>;
export declare const REGISTRY: Command[];
export declare function lookupCommand(name: string, snapshot?: ModuleSnapshot): Command | undefined;
/** Topic IDs available to `phren help <topic>`, including doc topics and `all`. */
export declare function helpTopicNames(): string[];
/** Topic IDs that are command groups (excludes doc topics and `all`). */
export declare function commandTopics(): readonly Topic[];
export declare function disabledCommand(command: string, snapshot: ModuleSnapshot): string | undefined;
export declare function commandsForModules(snapshot?: ModuleSnapshot): Command[];
