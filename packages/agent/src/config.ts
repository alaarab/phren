import * as os from "node:os";
import * as path from "node:path";
import type { PermissionMode } from "./permissions/types.js";
import { loadPermissionMode } from "./settings.js";

export const AGENT_CONFIG_DIR = ".phren-agent";

export function agentConfigDir(base: string): string {
  return path.join(base, AGENT_CONFIG_DIR);
}

export function agentUserDir(home: string = os.homedir()): string {
  return path.join(home, AGENT_CONFIG_DIR);
}

export interface CliArgs {
  task: string;
  provider?: string;
  model?: string;
  reasoning?: "low" | "medium" | "high" | "xhigh";
  project?: string;
  permissions: PermissionMode;
  permissionsExplicit: boolean;
  maxTurns: number;
  maxOutput?: number;
  budget: number | null;
  plan: boolean;
  dryRun: boolean;
  verbose: boolean;
  interactive: boolean;
  resume: boolean;
  /** Resume this session (id or unique id prefix) instead of the newest. */
  resumeId?: string;
  /** Print recent sessions and exit. */
  listSessions: boolean;
  /** Headless: no prompts, stdout carries only `outputFormat`. */
  print: boolean;
  outputFormat: "text" | "json" | "stream-json";
  /** OpenAI-compatible endpoint for --provider openai-compat (or deepseek override). */
  baseUrl?: string;
  lintCmd?: string;
  testCmd?: string;
  mcp: string[];
  mcpConfig?: string;
  team?: string;
  multi: boolean;
  /** Disable subagent tools in one-shot mode (they are on by default). */
  noSubagents: boolean;
  /** Disable LLM compaction (falls back to regex prune summaries). */
  noLlmCompact: boolean;
  /** Kernel write-fence for shell commands: off | auto | require. */
  sandbox: "off" | "auto" | "require";
  help: boolean;
  version: boolean;
}

const HELP = `
phren-agent — coding agent with persistent memory

Usage: phren-agent [options] <task>    (also: phren agent [options] <task>)

Options:
  --provider <name>    Force provider: openai-codex, openai, openrouter, anthropic, deepseek,
                       openai-compat, ollama
  --base-url <url>     Endpoint for openai-compat (or to override deepseek's)
  --model <model>      Override LLM model
  --reasoning <level>  Reasoning effort: low, medium, high, xhigh
  --project <name>     Force phren project context
  --max-turns <n>      Max tool-use turns (default: 50)
  --max-output <n>     Max output tokens per response (default: auto per model)
  --budget <dollars>   Max spend in USD (aborts when exceeded)
  --plan               Plan mode: show plan before executing tools
  --no-subagents       Disable spawn_agent/send_message/list_agents in one-shot mode
  --no-llm-compact     Use regex prune summaries instead of LLM compaction
  --sandbox <mode>     Kernel write-fence for shell (bwrap): off, auto (default), require
  --permissions <mode> Permission mode: suggest (default), auto-confirm, full-auto
  --yolo               Full-auto permissions — no confirmations (alias for --permissions full-auto)
  --interactive, -i    Interactive REPL mode (multi-turn conversation)
  --resume, -c         Resume the newest session's conversation (task optional)
  --session <id>       Resume a specific session by id or unique id prefix
  --list-sessions      List recent sessions and exit
  -p, --print          Headless: no prompts (tool approvals are denied), clean stdout
  --output-format <f>  With -p: text (final message), json (one result object),
                       stream-json (NDJSON events + result). Implies -p
  --lint-cmd <cmd>     Override auto-detected lint command
  --test-cmd <cmd>     Override auto-detected test command
  --mcp <command>      Connect to an MCP server via stdio (repeatable)
  --mcp-config <path>  Load MCP server config from JSON file
  --team <name>        Start in team mode with named team coordination
  --multi              Start in multi-agent TUI mode
  --dry-run            Show system prompt and exit
  --verbose            Show tool calls as they execute
  --version            Show version
  --help               Show this help

Providers (auto-detected from env, or use --provider):
  openai-codex         Uses your ChatGPT/Codex subscription directly (preferred default)
                       (no API key needed, flat rate via your subscription)
                       Setup: phren-agent auth login
                       Legacy alias: codex
  openai               OPENAI_API_KEY — OpenAI direct (defaults to gpt-5.4)
  openrouter           OPENROUTER_API_KEY — routes to any model
  anthropic            ANTHROPIC_API_KEY — Claude direct
  deepseek             DEEPSEEK_API_KEY — DeepSeek's own API (api.deepseek.com)
  openai-compat        PHREN_AGENT_BASE_URL (or --base-url) + PHREN_AGENT_API_KEY —
                       any OpenAI-compatible /chat/completions endpoint
                       (OpenCode Go/Zen, Together, Fireworks, vLLM, LM Studio…)
  ollama               PHREN_OLLAMA_URL — local models (default: localhost:11434)

Environment:
  PHREN_AGENT_PROVIDER Force provider via env
  PHREN_AGENT_MODEL    Override model via env
  PHREN_AGENT_REASONING Override reasoning effort via env
  PHREN_AGENT_BASE_URL  Endpoint for openai-compat
  PHREN_AGENT_API_KEY   Key for openai-compat

Examples:
  phren-agent "fix the login bug"
  phren-agent --provider openai-codex "add input validation"
  phren-agent --model openai-codex/gpt-5.4 --reasoning high "add input validation"
  phren-agent --provider anthropic --verbose "refactor the database layer"
`.trim();

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    task: "",
    permissions: "suggest",
    permissionsExplicit: false,
    maxTurns: 50,
    budget: null,
    plan: false,
    dryRun: false,
    verbose: false,
    interactive: false,
    resume: false,
    listSessions: false,
    print: false,
    outputFormat: "text",
    noSubagents: false,
    noLlmCompact: false,
    sandbox: "auto",
    mcp: [],
    multi: false,
    help: false,
    version: false,
  };

  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { args.help = true; }
    else if (arg === "--version" || arg === "-v") { args.version = true; }
    else if (arg === "--dry-run") { args.dryRun = true; }
    else if (arg === "--verbose") { args.verbose = true; }
    else if (arg === "--interactive" || arg === "-i") { args.interactive = true; }
    else if (arg === "--no-subagents") { args.noSubagents = true; }
    else if (arg === "--no-llm-compact") { args.noLlmCompact = true; }
    else if (arg === "--sandbox" && argv[i + 1]) {
      const mode = argv[++i];
      if (mode === "off" || mode === "auto" || mode === "require") { args.sandbox = mode; }
    }
    else if (arg === "--plan") { args.plan = true; }
    else if (arg === "--resume" || arg === "--continue" || arg === "-c") { args.resume = true; }
    else if (arg === "--session" && argv[i + 1]) { args.resume = true; args.resumeId = argv[++i]; }
    else if (arg === "--list-sessions") { args.listSessions = true; }
    else if (arg === "--print" || arg === "-p") { args.print = true; }
    else if (arg === "--output-format" && argv[i + 1]) {
      const format = argv[++i];
      if (format === "text" || format === "json" || format === "stream-json") {
        args.outputFormat = format;
        args.print = true;
      } else {
        throw new Error(`Unknown --output-format "${format}". Use text, json or stream-json.`);
      }
    }
    else if (arg === "--base-url" && argv[i + 1]) { args.baseUrl = argv[++i]; }
    else if (arg === "--lint-cmd" && argv[i + 1]) { args.lintCmd = argv[++i]; }
    else if (arg === "--test-cmd" && argv[i + 1]) { args.testCmd = argv[++i]; }
    else if (arg === "--mcp" && argv[i + 1]) { args.mcp.push(argv[++i]); }
    else if (arg === "--mcp-config" && argv[i + 1]) { args.mcpConfig = argv[++i]; }
    else if (arg === "--team" && argv[i + 1]) { args.team = argv[++i]; }
    else if (arg === "--multi") { args.multi = true; }
    else if (arg === "--provider" && argv[i + 1]) { args.provider = argv[++i]; }
    else if (arg === "--model" && argv[i + 1]) { args.model = argv[++i]; }
    else if (arg === "--reasoning" && argv[i + 1]) {
      const value = argv[++i]?.toLowerCase();
      if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
        args.reasoning = value === "max" ? "xhigh" : value;
      }
    }
    else if (arg === "--project" && argv[i + 1]) { args.project = argv[++i]; }
    else if (arg === "--max-turns" && argv[i + 1]) { args.maxTurns = parseInt(argv[++i], 10) || 50; }
    else if (arg === "--max-output" && argv[i + 1]) { args.maxOutput = parseInt(argv[++i], 10) || undefined; }
    else if (arg === "--budget" && argv[i + 1]) { args.budget = parseFloat(argv[++i]) || null; }
    else if (arg === "--yolo") { args.permissions = "full-auto"; args.permissionsExplicit = true; }
    else if (arg === "--permissions" && argv[i + 1]) {
      const mode = argv[++i];
      if (mode === "suggest" || mode === "auto-confirm" || mode === "full-auto") {
        args.permissions = mode;
        args.permissionsExplicit = true;
      }
    }
    else if (!arg.startsWith("-")) { positional.push(arg); }
    i++;
  }

  args.task = positional.join(" ");
  // Also check env for model override
  if (!args.model && process.env.PHREN_AGENT_MODEL) {
    args.model = process.env.PHREN_AGENT_MODEL;
  }
  if (!args.reasoning && process.env.PHREN_AGENT_REASONING) {
    const value = process.env.PHREN_AGENT_REASONING.toLowerCase();
    if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
      args.reasoning = value === "max" ? "xhigh" : value;
    }
  }

  return args;
}

export function resolveStartupPermissions(args: CliArgs): void {
  if (args.permissionsExplicit) return;
  const saved = loadPermissionMode();
  if (saved) args.permissions = saved;
}

export function printHelp(): void {
  console.log(HELP);
}
