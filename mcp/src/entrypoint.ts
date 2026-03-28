import * as fs from "fs";
import * as path from "path";
import { parseMcpMode, runInit } from "./init/init.js";
import { errorMessage } from "./utils.js";
import { logger } from "./logger.js";
import { defaultPhrenPath, findPhrenPath } from "./shared.js";
import { addProjectFromPath } from "./core/project.js";
import {
  PROJECT_OWNERSHIP_MODES,
  getProjectOwnershipDefault,
  parseProjectOwnershipMode,
  type ProjectOwnershipMode,
} from "./project-config.js";


const HELP_TEXT = `phren - persistent knowledge for your agents

  phren                     Interactive shell
  phren init                Set up phren
  phren quickstart          Quick setup: init + project scaffold
  phren add [path]          Register a project
  phren search <query>      Search what phren knows
  phren status              Health check
  phren doctor [--fix]      Diagnose and repair
  phren web-ui              Open the knowledge graph
  phren tasks               Cross-project task view
  phren graph               Fragment knowledge graph

  phren help <topic>        Detailed help for a topic

Topics: projects, skills, hooks, config, maintain, setup, env, all
`;

const HELP_TOPICS: Record<string, string> = {
  projects: `Projects:
  phren add [path] [--ownership <mode>]   Register a project
  phren projects list                     List all tracked projects
  phren projects configure <name> [--ownership <mode>] [--hooks on|off]
                                           Update per-project settings
  phren projects remove <name>            Remove a project
`,
  skills: `Skills:
  phren skills list                       List installed skills
  phren skills add <project> <path>       Link a skill into a project
  phren skills show <name>                Show skill content
  phren skills resolve <project|global>   Print resolved skill manifest
  phren skills doctor <project|global>    Diagnose skill visibility
  phren skills sync <project|global>      Regenerate skill mirror
  phren skills enable <project|global> <name>  Enable a disabled skill
  phren skills disable <project|global> <name> Disable a skill without deleting
  phren skills remove <project> <name>    Remove a skill
  phren detect-skills [--import]          Find untracked skills in ~/.claude/skills/
`,
  hooks: `Hooks:
  phren hooks list [--project <name>]     Show hook status per tool
  phren hooks enable <tool>               Enable hooks for a tool
  phren hooks disable <tool>              Disable hooks for a tool
  phren hooks add-custom <event> <cmd>    Add a custom hook
  phren hooks remove-custom <event>       Remove custom hooks
  phren hooks errors [--limit <n>]        Show recent hook errors
`,
  config: `Configuration:
  phren config show [--project <name>]    Show current config
  phren config policy [get|set ...]       Retention, TTL, confidence, decay
  phren config workflow [get|set ...]     Risky-memory thresholds
  phren config proactivity [level]        Set proactivity level
  phren config task-mode [mode]           Set task automation mode
  phren config finding-sensitivity [lvl]  Set finding capture sensitivity
  phren config index [get|set ...]        Indexer include/exclude globs
  phren config synonyms [list|add|remove] Manage learned synonyms
  phren config project-ownership [mode]   Default ownership for new projects
  phren config machines                   Registered machines
  phren config profiles                   Profiles and projects
  phren config telemetry [on|off]         Opt-in usage telemetry

  All config subcommands accept --project <name> for per-project overrides.
`,
  maintain: `Maintenance:
  phren maintain govern [project]         Queue stale memories for review
  phren maintain prune [project]          Delete expired entries
  phren maintain consolidate [project]    Deduplicate findings
  phren maintain extract [project]        Mine git/GitHub signals
`,
  setup: `Setup:
  phren init [--mode shared|project-local] [--machine <n>] [--profile <n>] [--dry-run] [-y]
  phren quickstart                        Quick setup: init + project scaffold
  phren mcp-mode [on|off|status]          Toggle MCP integration
  phren hooks-mode [on|off|status]        Toggle hook execution
  phren verify                            Check init completed OK
  phren uninstall                         Remove phren config and hooks
  phren update [--refresh-starter]        Update to latest version
`,
  stores: `Stores:
  phren store list                        List registered stores
  phren store add <name> --remote <url>   Add a team store
  phren store remove <name>               Remove a store (local only)
  phren store sync                        Pull all stores
`,
  team: `Team:
  phren team init <name> [--remote <url>]     Create a new team store
  phren team join <git-url> [--name <name>]   Join an existing team store
  phren team add-project <store> <project>    Add a project to a team store
  phren team list                             List team stores
`,
  env: `Environment variables:
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
`,
};

function buildFullHelp(): string {
  return `phren - persistent knowledge for your agents

Usage:
  phren                     Interactive shell
  phren init                Set up phren
  phren quickstart          Quick setup: init + project scaffold
  phren add [path]          Register a project
  phren search <query>      Search what phren knows
  phren status              Health check
  phren doctor [--fix]      Diagnose and repair
  phren web-ui              Open the knowledge graph
  phren tasks               Cross-project task view
  phren graph               Fragment knowledge graph
  phren add-finding <p> "." Tell phren what you learned
  phren pin <p> "..."       Save a truth
  phren review [project]    Show review queue
  phren session-context     Current session state

${Object.values(HELP_TOPICS).join("\n")}`;
}


const CLI_COMMANDS = [
  "search",
  "shell",
  "update",
  "config",
  "maintain",
  "hook-prompt",
  "hook-session-start",
  "hook-stop",
  "hook-context",
  "hook-tool",
  "add-finding",
  "pin",
  "doctor",
  "debug-injection",
  "inspect-index",
  "web-ui",
  "quality-feedback",
  "skill-list",
  "skills",
  "hooks",
  "detect-skills",
  "task",
  "tasks",
  "finding",
  "quickstart",
  "background-maintenance",
  "background-sync",
  "projects",
  "extract-memories",
  "govern-memories",
  "prune-memories",
  "consolidate-memories",
  "index-policy",
  "policy",
  "workflow",
  "access",
  "review",
  "consolidation-status",
  "session-context",
  "truths",
  "store",
  "team",
  "promote",
];

async function flushTopLevelOutput(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
    new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
  ]);
}

async function finish(exitCode?: number): Promise<true> {
  if (exitCode !== undefined) process.exitCode = exitCode;
  await flushTopLevelOutput();
  return true;
}

function getOptionValue(args: string[], name: string): string | undefined {
  const exactIdx = args.indexOf(name);
  if (exactIdx !== -1) return args[exactIdx + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

function getPositionalArgs(args: string[], optionNamesWithValues: string[]): string[] {
  const positions: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (optionNamesWithValues.includes(arg)) {
      i += 1;
      continue;
    }
    if (optionNamesWithValues.some((name) => arg.startsWith(`${name}=`))) {
      continue;
    }
    if (!arg.startsWith("--")) positions.push(arg);
  }
  return positions;
}

function parseTaskModeFlag(raw: string | undefined): "off" | "manual" | "suggest" | "auto" | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return ["off", "manual", "suggest", "auto"].includes(normalized)
    ? normalized as "off" | "manual" | "suggest" | "auto"
    : undefined;
}

function parseProactivityFlag(raw: string | undefined): "high" | "medium" | "low" | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return ["high", "medium", "low"].includes(normalized)
    ? normalized as "high" | "medium" | "low"
    : undefined;
}

async function promptProjectOwnership(phrenPath: string, fallback: ProjectOwnershipMode): Promise<ProjectOwnershipMode> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `Project ownership [${PROJECT_OWNERSHIP_MODES.join("/")}] (${fallback}): `,
      (input) => {
        rl.close();
        resolve(parseProjectOwnershipMode(input.trim()) ?? fallback);
      }
    );
  });
}

export async function runTopLevelCommand(argv: string[]): Promise<boolean> {
  const argvCommand = argv[0];

  if (argvCommand === "--help" || argvCommand === "-h" || argvCommand === "help") {
    const topic = argv[1]?.toLowerCase();
    if (topic === "all") {
      console.log(buildFullHelp());
    } else if (topic && HELP_TOPICS[topic]) {
      console.log(HELP_TOPICS[topic]);
    } else if (topic) {
      console.log(`Unknown topic: ${topic}\nAvailable: ${Object.keys(HELP_TOPICS).join(", ")}, all`);
    } else {
      console.log(HELP_TEXT);
    }
    return finish();
  }

  if (argvCommand === "add") {
    const positional = getPositionalArgs(argv.slice(1), ["--ownership"]);
    const targetPath = positional[0] || process.cwd();
    const ownershipArg = getOptionValue(argv.slice(1), "--ownership");
    const phrenPath = defaultPhrenPath();
    const profile = (process.env.PHREN_PROFILE) || undefined;
    if (!fs.existsSync(phrenPath) || !fs.existsSync(path.join(phrenPath, ".config"))) {
      console.log("phren is not set up yet. Run: phren init");
      return finish(1);
    }
    const ownership = ownershipArg
      ? parseProjectOwnershipMode(ownershipArg)
      : await promptProjectOwnership(phrenPath, getProjectOwnershipDefault(phrenPath));
    if (ownershipArg && !ownership) {
      console.error(`Invalid --ownership value "${ownershipArg}". Use one of: ${PROJECT_OWNERSHIP_MODES.join(", ")}`);
      return finish(1);
    }
    try {
      const added = addProjectFromPath(phrenPath, path.resolve(targetPath), profile, ownership);
      if (!added.ok) {
        console.error(added.error);
        return finish(1);
      }
      console.log(`Added project "${added.data.project}" (${added.data.ownership})`);
      if (added.data.files.claude) console.log(`  ${added.data.files.claude}`);
      console.log(`  ${added.data.files.findings}`);
      console.log(`  ${added.data.files.task}`);
      console.log(`  ${added.data.files.summary}`);
    } catch (e) {
      console.error(`Could not add project: ${e instanceof Error ? e.message : String(e)}`);
      return finish(1);
    }
    return finish();
  }

  if (argvCommand === "init") {
    const initArgs = argv.slice(1);
    const machineIdx = initArgs.indexOf("--machine");
    const profileIdx = initArgs.indexOf("--profile");
    const mcpIdx = initArgs.indexOf("--mcp");
    const templateIdx = initArgs.indexOf("--template");
    const modeArg = getOptionValue(initArgs, "--mode");
    if (modeArg && !["shared", "project-local"].includes(modeArg)) {
      console.error(`Invalid --mode value "${modeArg}". Use "shared" or "project-local".`);
      return finish(1);
    }
    const ownershipMode = parseProjectOwnershipMode(getOptionValue(initArgs, "--project-ownership"));
    const taskMode = parseTaskModeFlag(getOptionValue(initArgs, "--task-mode"));
    const findingsProactivity = parseProactivityFlag(getOptionValue(initArgs, "--findings-proactivity"));
    const taskProactivity = parseProactivityFlag(getOptionValue(initArgs, "--task-proactivity"));
    const mcpMode = mcpIdx !== -1 ? parseMcpMode(initArgs[mcpIdx + 1]) : undefined;
    if (mcpIdx !== -1 && !mcpMode) {
      console.error(`Invalid --mcp value "${initArgs[mcpIdx + 1] || ""}". Use "on" or "off".`);
      return finish(1);
    }
    const ownershipArg = getOptionValue(initArgs, "--project-ownership");
    if (ownershipArg && !ownershipMode) {
      console.error(`Invalid --project-ownership value "${ownershipArg}". Use one of: ${PROJECT_OWNERSHIP_MODES.join(", ")}`);
      return finish(1);
    }
    const taskModeArg = getOptionValue(initArgs, "--task-mode");
    if (taskModeArg && !taskMode) {
      console.error(`Invalid --task-mode value "${taskModeArg}". Use one of: off, manual, suggest, auto.`);
      return finish(1);
    }
    const findingsArg = getOptionValue(initArgs, "--findings-proactivity");
    if (findingsArg && !findingsProactivity) {
      console.error(`Invalid --findings-proactivity value "${findingsArg}". Use one of: high, medium, low.`);
      return finish(1);
    }
    const taskArg = getOptionValue(initArgs, "--task-proactivity");
    if (taskArg && !taskProactivity) {
      console.error(`Invalid --task-proactivity value "${taskArg}". Use one of: high, medium, low.`);
      return finish(1);
    }
    const cloneUrl = getOptionValue(initArgs, "--clone-url");
    await runInit({
      mode: modeArg as "shared" | "project-local" | undefined,
      machine: machineIdx !== -1 ? initArgs[machineIdx + 1] : undefined,
      profile: profileIdx !== -1 ? initArgs[profileIdx + 1] : undefined,
      mcp: mcpMode,
      projectOwnershipDefault: ownershipMode,
      taskMode,
      findingsProactivity,
      taskProactivity,
      template: templateIdx !== -1 ? initArgs[templateIdx + 1] : undefined,
      applyStarterUpdate: initArgs.includes("--apply-starter-update"),
      dryRun: initArgs.includes("--dry-run"),
      yes: initArgs.includes("--yes") || initArgs.includes("-y"),
      express: initArgs.includes("--express"),
      _walkthroughCloneUrl: cloneUrl,
    });
    return finish();
  }

  if (argvCommand === "uninstall") {
    const { runUninstall } = await import("./init/init.js");
    const skipConfirm = argv.includes("--yes") || argv.includes("-y");
    await runUninstall({ yes: skipConfirm });
    return finish();
  }

  if (argvCommand === "status") {
    const { runStatus } = await import("./status.js");
    await runStatus();
    return finish();
  }

  if (argvCommand === "verify") {
    const { runPostInitVerify, getVerifyOutcomeNote } = await import("./init/init.js");
    const { getWorkflowPolicy } = await import("./shared/governance.js");
    const phrenPath = findPhrenPath() || defaultPhrenPath();
    const result = runPostInitVerify(phrenPath);
    console.log(`phren verify: ${result.ok ? "ok" : "issues found"}`);
    console.log(`  tasks: ${getWorkflowPolicy(phrenPath).taskMode} mode`);
    for (const check of result.checks) {
      console.log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
      if (!check.ok && check.fix) {
        console.log(`       fix: ${check.fix}`);
      }
    }
    if (!result.ok) {
      const note = getVerifyOutcomeNote(phrenPath, result.checks);
      if (note) console.log(`\nNote: ${note}`);
      console.log(`\nRun \`phren init\` to fix setup issues.`);
    }
    return finish(result.ok ? 0 : 1);
  }

  if (argvCommand === "mcp-mode") {
    const { runMcpMode } = await import("./init/init.js");
    try {
      await runMcpMode(argv[1]);
      return finish();
    } catch (err: unknown) {
      console.error(errorMessage(err));
      return finish(1);
    }
  }

  if (argvCommand === "hooks-mode") {
    const { runHooksMode } = await import("./init/init.js");
    try {
      await runHooksMode(argv[1]);
      return finish();
    } catch (err: unknown) {
      console.error(errorMessage(err));
      return finish(1);
    }
  }

  if (argvCommand === "link") {
    console.error("`phren link` has been removed. Use `phren init` instead.");
    return finish(1);
  }

  if (argvCommand === "--health") {
    return finish();
  }

  if (!argvCommand && process.stdin.isTTY && process.stdout.isTTY) {
    const { runCliCommand } = await import("./cli/cli.js");
    await runCliCommand("shell", []);
    return finish();
  }

  if (argvCommand && CLI_COMMANDS.includes(argvCommand)) {
    const { runCliCommand } = await import("./cli/cli.js");
    try {
      const { trackCliCommand } = await import("./telemetry.js");
      trackCliCommand(defaultPhrenPath(), argvCommand);
    } catch (err: unknown) {
      logger.debug("cli", `trackCliCommand: ${errorMessage(err)}`);
    }
    await runCliCommand(argvCommand, argv.slice(1));
    return finish();
  }

  return false;
}
