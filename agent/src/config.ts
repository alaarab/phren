import type { PermissionMode } from "./permissions/types.js";

export interface CliArgs {
  task: string;
  provider?: string;
  model?: string;
  project?: string;
  permissions: PermissionMode;
  maxTurns: number;
  budget: number | null;
  plan: boolean;
  dryRun: boolean;
  verbose: boolean;
  interactive: boolean;
  resume: boolean;
  lintCmd?: string;
  testCmd?: string;
  mcp: string[];
  mcpConfig?: string;
  help: boolean;
  version: boolean;
}

const HELP = `
phren-agent — coding agent with persistent memory

Usage: phren-agent [options] <task>

Options:
  --provider <name>    Force provider: openrouter, anthropic, openai, codex, ollama
  --model <model>      Override LLM model
  --project <name>     Force phren project context
  --max-turns <n>      Max tool-use turns (default: 50)
  --budget <dollars>   Max spend in USD (aborts when exceeded)
  --plan               Plan mode: show plan before executing tools
  --permissions <mode> Permission mode: suggest, auto-confirm, full-auto (default: auto-confirm)
  --interactive, -i    Interactive REPL mode (multi-turn conversation)
  --resume             Resume last session's conversation
  --lint-cmd <cmd>     Override auto-detected lint command
  --test-cmd <cmd>     Override auto-detected test command
  --mcp <command>      Connect to an MCP server via stdio (repeatable)
  --mcp-config <path>  Load MCP server config from JSON file
  --dry-run            Show system prompt and exit
  --verbose            Show tool calls as they execute
  --version            Show version
  --help               Show this help

Providers (auto-detected from env, or use --provider):
  openrouter           OPENROUTER_API_KEY — routes to any model (default)
  anthropic            ANTHROPIC_API_KEY — Claude direct
  openai               OPENAI_API_KEY — OpenAI direct
  codex                Uses your ChatGPT/Codex subscription directly
                       (no API key needed, flat rate via your subscription)
                       Setup: phren-agent auth login
  ollama               PHREN_OLLAMA_URL — local models (default: localhost:11434)

Environment:
  PHREN_AGENT_PROVIDER Force provider via env
  PHREN_AGENT_MODEL    Override model via env

Examples:
  phren-agent "fix the login bug"
  phren-agent --provider codex "add input validation"
  phren-agent --provider anthropic --verbose "refactor the database layer"
`.trim();

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    task: "",
    permissions: "auto-confirm",
    maxTurns: 50,
    budget: null,
    plan: false,
    dryRun: false,
    verbose: false,
    interactive: false,
    resume: false,
    mcp: [],
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
    else if (arg === "--plan") { args.plan = true; }
    else if (arg === "--resume") { args.resume = true; }
    else if (arg === "--lint-cmd" && argv[i + 1]) { args.lintCmd = argv[++i]; }
    else if (arg === "--test-cmd" && argv[i + 1]) { args.testCmd = argv[++i]; }
    else if (arg === "--mcp" && argv[i + 1]) { args.mcp.push(argv[++i]); }
    else if (arg === "--mcp-config" && argv[i + 1]) { args.mcpConfig = argv[++i]; }
    else if (arg === "--provider" && argv[i + 1]) { args.provider = argv[++i]; }
    else if (arg === "--model" && argv[i + 1]) { args.model = argv[++i]; }
    else if (arg === "--project" && argv[i + 1]) { args.project = argv[++i]; }
    else if (arg === "--max-turns" && argv[i + 1]) { args.maxTurns = parseInt(argv[++i], 10) || 50; }
    else if (arg === "--budget" && argv[i + 1]) { args.budget = parseFloat(argv[++i]) || null; }
    else if (arg === "--permissions" && argv[i + 1]) {
      const mode = argv[++i];
      if (mode === "suggest" || mode === "auto-confirm" || mode === "full-auto") {
        args.permissions = mode;
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

  return args;
}

export function printHelp(): void {
  console.log(HELP);
}
