import type { PermissionMode } from "./permissions/types.js";
import type { EffortLevel } from "./providers/types.js";

export interface CliArgs {
  task: string;
  provider?: string;
  model?: string;
  project?: string;
  permissions: PermissionMode;
  maxTurns: number;
  maxOutput?: number;
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
  team?: string;
  multi: boolean;
  /** Reasoning effort level. */
  effort: EffortLevel;
  /** Path to hooks config file. */
  hooksConfig?: string;
  /** Granular permission allow rules (e.g., "Bash(npm run *)"). */
  allowRules: string[];
  /** Granular permission deny rules (e.g., "Bash(rm *)"). */
  denyRules: string[];
  /** Custom compaction instructions. */
  compactionInstructions?: string;
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
  --max-output <n>     Max output tokens per response (default: auto per model)
  --budget <dollars>   Max spend in USD (aborts when exceeded)
  --effort <level>     Reasoning effort: low, medium, high, max (default: high)
  --plan               Plan mode: show plan before executing tools
  --permissions <mode> Permission mode: suggest, auto-confirm, full-auto (default: auto-confirm)
  --allow <pattern>    Allow a tool pattern (e.g., "Bash(npm run *)", "Read(/src/**)")
  --deny <pattern>     Deny a tool pattern (e.g., "Bash(rm *)")
  --interactive, -i    Interactive REPL mode (multi-turn conversation)
  --resume             Resume last session's conversation
  --lint-cmd <cmd>     Override auto-detected lint command
  --test-cmd <cmd>     Override auto-detected test command
  --mcp <command>      Connect to an MCP server via stdio (repeatable)
  --mcp-config <path>  Load MCP server config from JSON file
  --hooks-config <p>   Load agent hooks config from JSON file
  --team <name>        Start in team mode with named team coordination
  --multi              Start in multi-agent TUI mode
  --dry-run            Show system prompt and exit
  --verbose            Show tool calls as they execute
  --version            Show version
  --help               Show this help

Permission patterns:
  --allow "Bash(npm run *)"      Allow bash commands matching glob
  --allow "Read(/src/**)"        Allow reading files under /src
  --allow "WebFetch(domain:x.com)" Allow fetching from a domain
  --deny "Bash(rm *)"            Block bash commands matching glob

Effort levels:
  low     Minimal reasoning — file lookups, simple questions ($)
  medium  Balanced — routine edits, standard tasks ($$)
  high    Thorough — refactoring, debugging ($$$) [default]
  max     Maximum depth — complex multi-step problems ($$$$)

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
  phren-agent --effort low "what does this function do?"
  phren-agent --allow "Bash(npm *)" --provider codex "add validation"
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
    multi: false,
    effort: "high",
    allowRules: [],
    denyRules: [],
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
    else if (arg === "--hooks-config" && argv[i + 1]) { args.hooksConfig = argv[++i]; }
    else if (arg === "--team" && argv[i + 1]) { args.team = argv[++i]; }
    else if (arg === "--multi") { args.multi = true; }
    else if (arg === "--effort" && argv[i + 1]) {
      const level = argv[++i];
      if (level === "low" || level === "medium" || level === "high" || level === "max") {
        args.effort = level;
      }
    }
    else if (arg === "--allow" && argv[i + 1]) { args.allowRules.push(argv[++i]); }
    else if (arg === "--deny" && argv[i + 1]) { args.denyRules.push(argv[++i]); }
    else if (arg === "--provider" && argv[i + 1]) { args.provider = argv[++i]; }
    else if (arg === "--model" && argv[i + 1]) { args.model = argv[++i]; }
    else if (arg === "--project" && argv[i + 1]) { args.project = argv[++i]; }
    else if (arg === "--max-turns" && argv[i + 1]) { args.maxTurns = parseInt(argv[++i], 10) || 50; }
    else if (arg === "--max-output" && argv[i + 1]) { args.maxOutput = parseInt(argv[++i], 10) || undefined; }
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
