import * as fs from "fs";
import * as path from "path";
import { parseMcpMode, runInit } from "./init.js";
import { errorMessage } from "./utils.js";
import { defaultCortexPath } from "./shared.js";
import { addProjectFromPath } from "./core-project.js";


const HELP_TEXT = `cortex - Long-term memory for Claude Code

Usage:
  cortex                                 Open interactive shell
  cortex quickstart                      Quick setup: init + project scaffold
  cortex add [path]                      Add current directory (or path) as a cortex project
  cortex init [--machine <n>] [--profile <n>] [--mcp on|off] [--template <t>] [--dry-run] [-y]
                                         Set up cortex and auto-bootstrap the current project directory
  cortex projects list                   List all tracked projects
  cortex projects remove <name>          Remove a project (asks for confirmation)
  cortex detect-skills [--import]        Find untracked skills in ~/.claude/skills/
  cortex skills list                     List installed skills
  cortex skills add <project> <path>    Link or copy a skill file into one project
  cortex skills resolve <project|global> Print the resolved skill manifest for one scope
  cortex skills doctor <project|global> Diagnose resolved skill visibility + mirror state
  cortex skills sync <project|global>   Regenerate the resolved mirror for one scope
  cortex skills remove <project> <name> Remove a project skill by name
  cortex hooks list                      Show hook tool preferences
  cortex hooks enable <tool>             Enable hooks for one tool
  cortex hooks disable <tool>            Disable hooks for one tool
  cortex status                          Health, active project, stats
  cortex search <query> [--project <n>] [--type <t>] [--limit <n>]
                                         Search your cortex
  cortex add-finding <project> "..."     Save an insight
  cortex pin <project> "..."             Pin a canonical memory
  cortex tasks                           Cross-project task view
  cortex skill-list                      List installed skills
  cortex doctor [--fix] [--check-data] [--agents]
                                         Health check and self-heal (--agents: show agent integrations only)
  cortex review-ui [--port=3499]         Memory review web UI
  cortex debug-injection --prompt "..."  Preview hook-prompt injection output
  cortex inspect-index [--project <n>]   Inspect FTS index contents for debugging
  cortex update [--refresh-starter]      Update to latest version

Configuration:
  cortex config policy [get|set ...]     Retention, TTL, confidence, decay
  cortex config workflow [get|set ...]   Approval gates, risky-memory thresholds
  cortex config access [get|set ...]     Role-based permissions
  cortex config index [get|set ...]      Indexer include/exclude globs
  cortex config machines                 Registered machines
  cortex config profiles                 Profiles and projects

Maintenance:
  cortex maintain govern [project]       Queue stale/low-value memories for review
  cortex maintain prune [project]        Delete expired entries
  cortex maintain consolidate [project]  Deduplicate FINDINGS.md
  cortex maintain extract [project]      Mine git/GitHub signals

Setup:
  cortex mcp-mode [on|off|status]        Toggle MCP integration
  cortex hooks-mode [on|off|status]      Toggle hook execution
  cortex verify                          Check init completed OK
  cortex uninstall                       Remove cortex config and hooks

Environment:
  CORTEX_PATH                Override cortex directory (default: ~/.cortex)
  CORTEX_PROFILE             Active profile name (otherwise cortex uses machines.yaml when available)
  CORTEX_DEBUG               Enable debug logging (set to 1)
  CORTEX_OLLAMA_URL          Ollama base URL (default: http://localhost:11434; set to 'off' to disable)
  CORTEX_EMBEDDING_API_URL   OpenAI-compatible /embeddings endpoint (cloud alternative to Ollama)
  CORTEX_EMBEDDING_API_KEY   API key for CORTEX_EMBEDDING_API_URL
  CORTEX_EMBEDDING_MODEL     Embedding model (default: nomic-embed-text)
  CORTEX_EXTRACT_MODEL       Ollama model for memory extraction (default: llama3.2)
  CORTEX_EMBEDDING_PROVIDER  Set to 'api' to use OpenAI API for search_knowledge embeddings
  CORTEX_FEATURE_AUTO_CAPTURE=1      Extract insights from conversations at session end
  CORTEX_FEATURE_SEMANTIC_DEDUP=1    LLM-based dedup on add_finding
  CORTEX_FEATURE_SEMANTIC_CONFLICT=1 LLM-based conflict detection on add_finding
  CORTEX_FEATURE_HYBRID_SEARCH=0     Disable TF-IDF cosine fallback in search_knowledge
  CORTEX_FEATURE_AUTO_EXTRACT=0      Disable automatic memory extraction on each prompt
  CORTEX_FEATURE_PROGRESSIVE_DISCLOSURE=1  Compact memory index injection
  CORTEX_LLM_MODEL           LLM model for semantic dedup/conflict (default: gpt-4o-mini)
  CORTEX_LLM_ENDPOINT        OpenAI-compatible /chat/completions base URL for dedup/conflict
  CORTEX_LLM_KEY             API key for CORTEX_LLM_ENDPOINT
  CORTEX_CONTEXT_TOKEN_BUDGET    Max tokens injected per hook-prompt (default: 550)
  CORTEX_CONTEXT_SNIPPET_LINES   Max lines per injected snippet (default: 6)
  CORTEX_CONTEXT_SNIPPET_CHARS   Max chars per injected snippet (default: 520)
  CORTEX_MAX_INJECT_TOKENS       Hard cap on total injected tokens (default: 2000)
  CORTEX_BACKLOG_PRIORITY        Priorities to include in task injection: high,medium,low (default: high,medium)
  CORTEX_MEMORY_TTL_DAYS         Override memory TTL for trust filtering
  CORTEX_HOOK_TIMEOUT_MS         Hook subprocess timeout in ms (default: 14000)
  CORTEX_FINDINGS_CAP            Max findings per date section before consolidation (default: 20)
  CORTEX_GH_PR_LIMIT/RUN_LIMIT/ISSUE_LIMIT  GitHub extraction limits (defaults: 40/25/25)

Examples:
  cortex search "rate limiting"          Search across all projects
  cortex search "auth" --project my-api  Search within one project
  cortex add-finding my-app "Redis connections need explicit close in finally blocks"
  cortex doctor --fix                    Fix common config issues
  cortex config policy set --ttlDays=90  Change memory retention to 90 days
  cortex maintain govern my-app          Queue stale memories for review
  cortex status                          Quick health check
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
  "review-ui",
  "quality-feedback",
  "skill-list",
  "skills",
  "hooks",
  "detect-skills",
  "tasks",
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

export async function runTopLevelCommand(argv: string[]): Promise<boolean> {
  const argvCommand = argv[0];

  if (argvCommand === "--help" || argvCommand === "-h" || argvCommand === "help") {
    console.log(HELP_TEXT);
    return finish();
  }

  if (argvCommand === "add") {
    const targetPath = argv[1] || process.cwd();
    const cortexPath = defaultCortexPath();
    const profile = process.env.CORTEX_PROFILE || undefined;
    if (!fs.existsSync(cortexPath) || !fs.existsSync(path.join(cortexPath, ".governance"))) {
      console.log("cortex is not set up yet. Run: npx @alaarab/cortex init");
      return finish(1);
    }
    try {
      const added = addProjectFromPath(cortexPath, path.resolve(targetPath), profile);
      if (!added.ok) {
        console.error(added.error);
        return finish(1);
      }
      console.log(`Added project "${added.data.project}"`);
      console.log(`  ${added.data.files.claude}`);
      console.log(`  ${added.data.files.findings}`);
      console.log(`  ${added.data.files.backlog}`);
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
    const mcpMode = mcpIdx !== -1 ? parseMcpMode(initArgs[mcpIdx + 1]) : undefined;
    if (mcpIdx !== -1 && !mcpMode) {
      console.error(`Invalid --mcp value "${initArgs[mcpIdx + 1] || ""}". Use "on" or "off".`);
      return finish(1);
    }
    await runInit({
      machine: machineIdx !== -1 ? initArgs[machineIdx + 1] : undefined,
      profile: profileIdx !== -1 ? initArgs[profileIdx + 1] : undefined,
      mcp: mcpMode,
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
    const cortexPath = defaultCortexPath();
    const result = runPostInitVerify(cortexPath);
    console.log(`cortex verify: ${result.ok ? "ok" : "issues found"}`);
    console.log(`  tasks: ${getWorkflowPolicy(cortexPath).taskMode} mode`);
    for (const check of result.checks) {
      console.log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
      if (!check.ok && check.fix) {
        console.log(`       fix: ${check.fix}`);
      }
    }
    if (!result.ok) {
      const note = getVerifyOutcomeNote(cortexPath, result.checks);
      if (note) console.log(`\nNote: ${note}`);
      console.log(`\nRun \`npx @alaarab/cortex init\` to fix setup issues.`);
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
    console.error("`cortex link` has been removed. Use `npx @alaarab/cortex init` instead.");
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
      trackCliCommand(defaultCortexPath(), argvCommand);
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cli trackCliCommand: ${errorMessage(err)}\n`);
    }
    await runCliCommand(argvCommand, argv.slice(1));
    return finish();
  }

  return false;
}
