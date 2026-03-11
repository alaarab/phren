import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  findCortexPath,
  getProjectDirs,
  EXEC_TIMEOUT_QUICK_MS,
  debugLog,
  isRecord,
  hookConfigPath,
  homeDir,
} from "./shared.js";
import { detectProject, findFtsCacheForPath, listIndexedDocumentPaths } from "./shared-index.js";
import { getMcpEnabledPreference, getHooksEnabledPreference } from "./init.js";
import { getTelemetrySummary } from "./telemetry.js";
import { runGit as runGitShared } from "./utils.js";
import { readRuntimeHealth, resolveTaskFilePath } from "./data-access.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readPackageVersion: ${err instanceof Error ? err.message : String(err)}\n`);
    return "unknown";
  }
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function check(ok: boolean): string {
  return ok ? `${GREEN}ok${RESET}` : `${RED}missing${RESET}`;
}

function countBullets(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf8");
  return content.split("\n").filter((l) => l.startsWith("- ")).length;
}

function countQueueItems(cortexPath: string, project: string): number {
  const queueFile = path.join(cortexPath, project, "MEMORY_QUEUE.md");
  return countBullets(queueFile);
}

function runGit(cwd: string, args: string[]): string | null {
  return runGitShared(cwd, args, EXEC_TIMEOUT_QUICK_MS, debugLog);
}

function hasCommandHook(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((hook) => isRecord(hook) && typeof hook.command === "string" && hook.command.includes("cortex"));
  });
}

export async function runStatus() {
  const cortexPath = findCortexPath();
  if (!cortexPath) {
    console.log(`${RED}cortex not found${RESET}. Run ${CYAN}npx cortex init${RESET} to set up.`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const profile = resolveRuntimeProfile(cortexPath);
  const activeProject = detectProject(cortexPath, cwd, profile);

  const version = readPackageVersion();
  console.log(`\n${BOLD}cortex status${RESET} ${DIM}v${version}${RESET}\n`);

  // Active project
  if (activeProject) {
    console.log(`  ${BOLD}Project:${RESET}  ${CYAN}${activeProject}${RESET} ${DIM}(detected from cwd)${RESET}`);
  } else {
    console.log(`  ${BOLD}Project:${RESET}  ${DIM}none detected${RESET}`);
  }

  // Cortex path
  console.log(`  ${BOLD}Path:${RESET}     ${cortexPath}`);
  if (profile) {
    console.log(`  ${BOLD}Profile:${RESET}  ${profile}`);
  }

  // MCP + hooks status
  const mcpEnabled = getMcpEnabledPreference(cortexPath);
  const hooksEnabled = getHooksEnabledPreference(cortexPath);
  console.log(`  ${BOLD}MCP:${RESET}      ${mcpEnabled ? `${GREEN}on${RESET}` : `${YELLOW}off${RESET}`}`);
  console.log(`  ${BOLD}Hooks:${RESET}    ${hooksEnabled ? `${GREEN}on${RESET}` : `${YELLOW}off${RESET}`}`);

  // Hook health: check ~/.claude/settings.json
  const settingsPath = hookConfigPath("claude");
  let hooksInstalled = false;
  let mcpConfigured = false;
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
      const settings = isRecord(parsed) ? parsed : {};
      const mcpServers = isRecord(settings.mcpServers) ? settings.mcpServers : undefined;
      const hooks = isRecord(settings.hooks) ? settings.hooks : undefined;
      mcpConfigured = Boolean(mcpServers?.cortex);
      const hookEvents = ["UserPromptSubmit", "Stop", "SessionStart"];
      hooksInstalled = hookEvents.every((event) => hasCommandHook(hooks?.[event]));
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] statusHooks settingsParse: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  console.log(`  ${BOLD}MCP cfg:${RESET}  ${check(mcpConfigured)} ${DIM}(in settings.json)${RESET}`);
  console.log(`  ${BOLD}Hooks cfg:${RESET} ${check(hooksInstalled)} ${DIM}(in settings.json)${RESET}`);

  // FTS index health
  let ftsIndexOk = false;
  let ftsIndexSize = 0;
  try {
    const cache = findFtsCacheForPath(cortexPath, profile);
    ftsIndexOk = cache.exists;
    ftsIndexSize = cache.sizeBytes ?? 0;
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] statusFtsIndex: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  const ftsLabel = ftsIndexOk
    ? `${GREEN}ok${RESET} ${DIM}(${(ftsIndexSize / 1024).toFixed(0)} KB)${RESET}`
    : `${YELLOW}not built${RESET} ${DIM}(run a search to build)${RESET}`;
  console.log(`  ${BOLD}FTS index:${RESET} ${ftsLabel}`);

  try {
    const { getOllamaUrl, checkOllamaAvailable, checkModelAvailable, getEmbeddingModel } = await import("./shared-ollama.js");
    const { getEmbeddingCache, formatEmbeddingCoverage } = await import("./shared-embedding-cache.js");
    const ollamaUrl = getOllamaUrl();
    if (!ollamaUrl) {
      console.log(`  ${BOLD}Semantic:${RESET} ${DIM}disabled (optional)${RESET}`);
    } else {
      const available = await checkOllamaAvailable();
      if (!available) {
        console.log(`  ${BOLD}Semantic:${RESET} ${YELLOW}offline${RESET} ${DIM}(${ollamaUrl})${RESET}`);
      } else {
        const modelReady = await checkModelAvailable();
        const model = getEmbeddingModel();
        if (!modelReady) {
          console.log(`  ${BOLD}Semantic:${RESET} ${YELLOW}model missing${RESET} ${DIM}(${model})${RESET}`);
        } else {
          const cache = getEmbeddingCache(cortexPath);
          await cache.load().catch(() => {});
          const coverage = cache.coverage(listIndexedDocumentPaths(cortexPath, profile || undefined));
          console.log(`  ${BOLD}Semantic:${RESET} ${GREEN}ready${RESET} ${DIM}(${model}; ${formatEmbeddingCoverage(coverage)})${RESET}`);
        }
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] statusSemantic: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Agent integration status
  function hasCortexEntry(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return raw.includes('"cortex"') || raw.includes("'cortex'");
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hasCortexEntry: ${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  }
  function agentConfigured(candidates: string[]): boolean {
    return candidates.some(hasCortexEntry);
  }
  const home = homeDir();
  const agentChecks: { name: string; configured: boolean }[] = [
    {
      name: "Claude Code",
      configured: agentConfigured([
        path.join(home, ".claude.json"),
        path.join(home, ".claude", "settings.json"),
      ]),
    },
    {
      name: "Cursor",
      configured: agentConfigured([
        path.join(home, ".cursor", "mcp.json"),
        path.join(home, ".config", "Cursor", "User", "mcp.json"),
        path.join(home, "Library", "Application Support", "Cursor", "User", "mcp.json"),
      ]),
    },
    {
      name: "Copilot CLI",
      configured: agentConfigured([
        path.join(home, ".copilot", "mcp-config.json"),
        path.join(home, ".config", "github-copilot", "mcp.json"),
        path.join(home, "Library", "Application Support", "github-copilot", "mcp.json"),
      ]),
    },
    {
      name: "Codex",
      configured: agentConfigured([
        path.join(home, ".codex", "config.json"),
        path.join(home, ".codex", "mcp.json"),
        path.join(home, ".codex", "config.toml"),
      ]),
    },
    {
      name: "Windsurf",
      configured: agentConfigured([
        path.join(home, ".windsurf", "mcp.json"),
        path.join(home, ".config", "Windsurf", "User", "mcp.json"),
        path.join(home, "Library", "Application Support", "Windsurf", "User", "mcp.json"),
      ]),
    },
  ];
  const configuredAgents = agentChecks.filter((a) => a.configured).map((a) => a.name);
  const missingAgents = agentChecks.filter((a) => !a.configured).map((a) => a.name);
  if (configuredAgents.length > 0) {
    console.log(`  ${BOLD}Agents:${RESET}   ${GREEN}${configuredAgents.join(", ")}${RESET}`);
  }
  if (missingAgents.length > 0) {
    console.log(`  ${DIM}          Not configured: ${missingAgents.join(", ")} — run cortex init to add${RESET}`);
  }

  // Stats
  const projectDirs = getProjectDirs(cortexPath, profile);
  let totalFindings = 0;
  let totalBacklog = 0;
  let totalQueue = 0;

  for (const dir of projectDirs) {
    const projName = path.basename(dir);
    totalFindings += countBullets(path.join(cortexPath, projName, "FINDINGS.md"));
    const taskPath = resolveTaskFilePath(cortexPath, projName);
    if (taskPath) totalBacklog += countBullets(taskPath);
    totalQueue += countQueueItems(cortexPath, projName);
  }

  console.log(`\n  ${BOLD}Stats:${RESET}    ${projectDirs.length} projects, ${totalFindings} findings, ${totalBacklog} tasks, ${totalQueue} queued`);

  const runtime = readRuntimeHealth(cortexPath);
  console.log(`\n  ${BOLD}Sync:${RESET}     auto-save ${runtime.lastAutoSave?.status || "n/a"}`);
  console.log(`             last pull ${runtime.lastSync?.lastPullStatus || "n/a"}${runtime.lastSync?.lastPullAt ? ` @ ${runtime.lastSync.lastPullAt}` : ""}`);
  console.log(`             last push ${runtime.lastSync?.lastPushStatus || "n/a"}${runtime.lastSync?.lastPushAt ? ` @ ${runtime.lastSync.lastPushAt}` : ""}`);
  console.log(`             unsynced commits: ${runtime.lastSync?.unsyncedCommits ?? 0}`);
  if (runtime.lastSync?.lastPushDetail) {
    console.log(`             push detail: ${runtime.lastSync.lastPushDetail}`);
  }

  // Recent changes (git log)
  const isGitRepo = runGit(cortexPath, ["rev-parse", "--is-inside-work-tree"]);
  if (isGitRepo === "true") {
    const log = runGit(cortexPath, ["log", "--oneline", "-5", "--no-decorate"]);
    if (log) {
      console.log(`\n  ${BOLD}Recent changes:${RESET}`);
      for (const line of log.split("\n")) {
        console.log(`    ${DIM}${line}${RESET}`);
      }
    }
    const dirty = runGit(cortexPath, ["status", "--porcelain"]);
    if (dirty) {
      const count = dirty.split("\n").filter(Boolean).length;
      console.log(`    ${YELLOW}${count} uncommitted change(s)${RESET}`);
    }
  } else {
    console.log(`\n  ${DIM}~/.cortex is not a git repo${RESET}`);
  }

  // Telemetry
  const telemetry = getTelemetrySummary(cortexPath);
  const firstLine = telemetry.split("\n")[0];
  console.log(`\n  ${BOLD}${firstLine}${RESET}`);

  console.log("");
}
