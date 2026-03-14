import * as fs from "fs";
import * as path from "path";
import { parseMcpMode, runInit } from "./init.js";
import { errorMessage } from "./utils.js";
import { defaultPhrenPath, findPhrenPath } from "./shared.js";
import { addProjectFromPath } from "./core-project.js";
import {
  PROJECT_OWNERSHIP_MODES,
  getProjectOwnershipDefault,
  parseProjectOwnershipMode,
  type ProjectOwnershipMode,
} from "./project-config.js";


const HELP_TEXT = `phren - He remembers so your agent doesn't have to

Usage:
  phren                                 Open interactive shell
  phren quickstart                      Quick setup: init + project scaffold
  phren add [path] [--ownership <mode>] Add current directory (or path) as a project
  phren init [--mode shared|project-local] [--machine <n>] [--profile <n>] [--mcp on|off] [--template <t>] [--dry-run] [-y]
                                         Set up phren and offer to add the current project directory
  phren projects list                   List all tracked projects
  phren projects configure <name> [--ownership <mode>] [--hooks on|off]
                                         Update per-project enrollment and hook settings
  phren projects remove <name>          Remove a project (asks for confirmation)
  phren detect-skills [--import]        Find untracked skills in ~/.claude/skills/
  phren skills list                     List installed skills
  phren skills add <project> <path>    Link or copy a skill file into one project
  phren skills resolve <project|global> Print the resolved skill manifest for one scope
  phren skills doctor <project|global> Diagnose resolved skill visibility + mirror state
  phren skills sync <project|global>   Regenerate the resolved mirror for one scope
  phren skills remove <project> <name> Remove a project skill by name
  phren hooks list [--project <name>]   Show hook tool preferences and optional project overrides
  phren hooks enable <tool>             Enable hooks for one tool
  phren hooks disable <tool>            Disable hooks for one tool
  phren status                          Health, active project, stats
  phren search <query> [--project <n>] [--type <t>] [--limit <n>]
                                         Search what phren remembers
  phren add-finding <project> "..."     Tell phren what you learned
  phren pin <project> "..."             Save a truth
  phren tasks                           Cross-project task view
  phren skill-list                      List installed skills
  phren doctor [--fix] [--check-data] [--agents]
                                         Health check and self-heal (--agents: show agent integrations only)
  phren web-ui [--port=3499] [--no-open]     Memory web UI
  phren debug-injection --prompt "..."  Preview hook-prompt injection output
  phren inspect-index [--project <n>]   Inspect FTS index contents for debugging
  phren update [--refresh-starter]      Update to latest version
  phren graph [--project <n>] [--limit <n>]
                                         Show the fragment knowledge graph
  phren graph link <project> "finding" "fragment"
                                         Link a finding to a fragment manually

Configuration:
  phren config policy [get|set ...]     Retention, TTL, confidence, decay
  phren config workflow [get|set ...]   Risky-memory thresholds
  phren config index [get|set ...]      Indexer include/exclude globs
  phren config synonyms [list|add|remove] ...
                                         Manage project learned synonyms
  phren config project-ownership [mode] Default ownership for future project enrollments
  phren config machines                 Registered machines
  phren config profiles                 Profiles and projects

Maintenance:
  phren maintain govern [project]       Queue stale/low-value memories for review
  phren maintain prune [project]        Delete expired entries
  phren maintain consolidate [project]  Deduplicate FINDINGS.md
  phren maintain extract [project]      Mine git/GitHub signals

Setup:
  phren mcp-mode [on|off|status]        Toggle MCP integration
  phren hooks-mode [on|off|status]      Toggle hook execution
  phren verify                          Check init completed OK
  phren uninstall                       Remove phren config and hooks

Environment:
  PHREN_PATH                Override phren directory (default: ~/.phren)
  PHREN_PROFILE             Active profile name (otherwise phren uses machines.yaml when available)
  PHREN_DEBUG               Enable debug logging (set to 1)
  PHREN_OLLAMA_URL          Ollama base URL (default: http://localhost:11434; set to 'off' to disable)
  PHREN_EMBEDDING_API_URL   OpenAI-compatible /embeddings endpoint (cloud alternative to Ollama)
  PHREN_EMBEDDING_API_KEY   API key for PHREN_EMBEDDING_API_URL
  PHREN_EMBEDDING_MODEL     Embedding model (default: nomic-embed-text)
  PHREN_EXTRACT_MODEL       Ollama model for memory extraction (default: llama3.2)
  PHREN_EMBEDDING_PROVIDER  Set to 'api' to use OpenAI API for search_knowledge embeddings
  PHREN_FEATURE_AUTO_CAPTURE=1      Extract insights from conversations at session end
  PHREN_FEATURE_SEMANTIC_DEDUP=1    LLM-based dedup on add_finding
  PHREN_FEATURE_SEMANTIC_CONFLICT=1 LLM-based conflict detection on add_finding
  PHREN_FEATURE_HYBRID_SEARCH=0     Disable TF-IDF cosine fallback in search_knowledge
  PHREN_FEATURE_AUTO_EXTRACT=0      Disable automatic memory extraction on each prompt
  PHREN_FEATURE_PROGRESSIVE_DISCLOSURE=1  Compact memory index injection
  PHREN_LLM_MODEL           LLM model for semantic dedup/conflict (default: gpt-4o-mini)
  PHREN_LLM_ENDPOINT        OpenAI-compatible /chat/completions base URL for dedup/conflict
  PHREN_LLM_KEY             API key for PHREN_LLM_ENDPOINT
  PHREN_CONTEXT_TOKEN_BUDGET    Max tokens injected per hook-prompt (default: 550)
  PHREN_CONTEXT_SNIPPET_LINES   Max lines per injected snippet (default: 6)
  PHREN_CONTEXT_SNIPPET_CHARS   Max chars per injected snippet (default: 520)
  PHREN_MAX_INJECT_TOKENS       Hard cap on total injected tokens (default: 2000)
  PHREN_TASK_PRIORITY        Priorities to include in task injection: high,medium,low (default: high,medium)
  PHREN_MEMORY_TTL_DAYS         Override memory TTL for trust filtering
  PHREN_HOOK_TIMEOUT_MS         Hook subprocess timeout in ms (default: 14000)
  PHREN_FINDINGS_CAP            Max findings per date section before consolidation (default: 20)
  PHREN_GH_PR_LIMIT/RUN_LIMIT/ISSUE_LIMIT  GitHub extraction limits (defaults: 40/25/25)

Examples:
  phren search "rate limiting"          Search across all projects
  phren search "auth" --project my-api  Search within one project
  phren add-finding my-app "Redis connections need explicit close in finally blocks"
  phren doctor --fix                    Fix common config issues
  phren config policy set --ttlDays=90  Change memory retention to 90 days
  phren config project-ownership detached
  phren maintain govern my-app          Queue stale memories for review
  phren status                          Quick health check
`;

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
    console.log(HELP_TEXT);
    return finish();
  }

  if (argvCommand === "add") {
    const positional = getPositionalArgs(argv.slice(1), ["--ownership"]);
    const targetPath = positional[0] || process.cwd();
    const ownershipArg = getOptionValue(argv.slice(1), "--ownership");
    const phrenPath = defaultPhrenPath();
    const profile = (process.env.PHREN_PROFILE) || undefined;
    if (!fs.existsSync(phrenPath) || !fs.existsSync(path.join(phrenPath, ".governance"))) {
      console.log("phren is not set up yet. Run: npx phren init");
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
    });
    return finish();
  }

  if (argvCommand === "uninstall") {
    const { runUninstall } = await import("./init.js");
    await runUninstall();
    return finish();
  }

  if (argvCommand === "status") {
    const { runStatus } = await import("./status.js");
    await runStatus();
    return finish();
  }

  if (argvCommand === "verify") {
    const { runPostInitVerify, getVerifyOutcomeNote } = await import("./init.js");
    const { getWorkflowPolicy } = await import("./shared-governance.js");
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
      console.log(`\nRun \`npx phren init\` to fix setup issues.`);
    }
    return finish(result.ok ? 0 : 1);
  }

  if (argvCommand === "mcp-mode") {
    const { runMcpMode } = await import("./init.js");
    try {
      await runMcpMode(argv[1]);
      return finish();
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      return finish(1);
    }
  }

  if (argvCommand === "hooks-mode") {
    const { runHooksMode } = await import("./init.js");
    try {
      await runHooksMode(argv[1]);
      return finish();
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      return finish(1);
    }
  }

  if (argvCommand === "link") {
    console.error("`phren link` has been removed. Use `npx phren init` instead.");
    return finish(1);
  }

  if (argvCommand === "--health") {
    return finish();
  }

  if (!argvCommand && process.stdin.isTTY && process.stdout.isTTY) {
    const { runCliCommand } = await import("./cli.js");
    await runCliCommand("shell", []);
    return finish();
  }

  if (argvCommand && CLI_COMMANDS.includes(argvCommand)) {
    const { runCliCommand } = await import("./cli.js");
    try {
      const { trackCliCommand } = await import("./telemetry.js");
      trackCliCommand(defaultPhrenPath(), argvCommand);
    } catch (err: unknown) {
      if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] cli trackCliCommand: ${errorMessage(err)}\n`);
    }
    await runCliCommand(argvCommand, argv.slice(1));
    return finish();
  }

  return false;
}
