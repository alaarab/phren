import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  findPhrenPath,
  getProjectDirs,
  EXEC_TIMEOUT_QUICK_MS,
  debugLog,
  isRecord,
  hookConfigPath,
  homeDir,
  readRootManifest,
} from "./shared.js";
import { buildIndex, detectProject, findFtsCacheForPath, listIndexedDocumentPaths, queryRows } from "./shared-index.js";
import { getMcpEnabledPreference, getHooksEnabledPreference } from "./init.js";
import { getTelemetrySummary } from "./telemetry.js";
import { runGit as runGitShared } from "./utils.js";
import { readRuntimeHealth, resolveTaskFilePath } from "./data-access.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { renderPhrenArt } from "./phren-art.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] readPackageVersion: ${err instanceof Error ? err.message : String(err)}\n`);
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

function countQueueItems(phrenPath: string, project: string): number {
  const queueFile = path.join(phrenPath, project, "review.md");
  return countBullets(queueFile);
}

function runGit(cwd: string, args: string[]): string | null {
  return runGitShared(cwd, args, EXEC_TIMEOUT_QUICK_MS, debugLog);
}

function hasCommandHook(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((hook) => isRecord(hook) && typeof hook.command === "string" && (hook.command.includes("phren") || hook.command.includes("phren")));
  });
}

export async function runStatus() {
  const phrenPath = findPhrenPath();
  if (!phrenPath) {
    console.log(`${RED}phren not found${RESET}. Run ${CYAN}npx phren init${RESET} to set up.`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const manifest = readRootManifest(phrenPath);
  const profile = resolveRuntimeProfile(phrenPath);
  const activeProject = detectProject(phrenPath, cwd, profile);

  const version = readPackageVersion();
  console.log("");
  console.log(renderPhrenArt("  "));
  console.log(`\n${BOLD}phren${RESET} ${DIM}v${version}${RESET}\n`);

  // Active project
  if (activeProject) {
    console.log(`  ${DIM}project${RESET}  ${activeProject}`);
  }

  // Phren path and config
  console.log(`  ${DIM}path${RESET}     ${phrenPath}`);
  console.log(`  ${DIM}mode${RESET}     ${manifest?.installMode || "unknown"}`);
  if (manifest?.workspaceRoot) {
    console.log(`  ${DIM}workspace${RESET} ${manifest.workspaceRoot}`);
  }
  if (manifest?.syncMode) {
    console.log(`  ${DIM}sync${RESET}     ${manifest.syncMode}`);
  }
  if (profile) {
    console.log(`  ${DIM}profile${RESET}  ${profile}`);
  }

  // MCP + hooks status
  const mcpEnabled = getMcpEnabledPreference(phrenPath);
  const hooksEnabled = getHooksEnabledPreference(phrenPath);
  console.log(`  ${DIM}mcp${RESET}      ${mcpEnabled ? `${GREEN}on${RESET}` : `${YELLOW}off${RESET}`}`);
  console.log(`  ${DIM}hooks${RESET}    ${hooksEnabled ? `${GREEN}on${RESET}` : `${YELLOW}off${RESET}`}`);

  // Hook health: check ~/.claude/settings.json
  let hooksInstalled = false;
  let mcpConfigured = false;
  if (manifest?.installMode === "project-local" && manifest.workspaceRoot) {
    const workspaceMcp = path.join(manifest.workspaceRoot, ".vscode", "mcp.json");
    if (fs.existsSync(workspaceMcp)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(workspaceMcp, "utf8")) as unknown;
        const settings = isRecord(parsed) ? parsed : {};
        const servers = isRecord(settings.servers) ? settings.servers : undefined;
        mcpConfigured = Boolean(servers?.phren || servers?.phren);
      } catch (err: unknown) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] statusWorkspaceMcp parse: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } else {
    const settingsPath = hookConfigPath("claude");
    if (fs.existsSync(settingsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
        const settings = isRecord(parsed) ? parsed : {};
        const mcpServers = isRecord(settings.mcpServers) ? settings.mcpServers : undefined;
        const hooks = isRecord(settings.hooks) ? settings.hooks : undefined;
        mcpConfigured = Boolean(mcpServers?.phren || mcpServers?.phren);
        const hookEvents = ["UserPromptSubmit", "Stop", "SessionStart"];
        hooksInstalled = hookEvents.every((event) => hasCommandHook(hooks?.[event]));
      } catch (err: unknown) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] statusHooks settingsParse: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
  console.log(`  ${DIM}mcp cfg${RESET}  ${check(mcpConfigured)} ${DIM}(${manifest?.installMode === "project-local" ? ".vscode/mcp.json" : "settings.json"})${RESET}`);
  if (manifest?.installMode === "project-local") {
    console.log(`  ${DIM}hooks cfg${RESET} ${DIM}n/a in project-local mode${RESET}`);
  } else {
    console.log(`  ${DIM}hooks cfg${RESET} ${check(hooksInstalled)} ${DIM}(settings.json)${RESET}`);
  }

  // FTS index health
  let ftsIndexOk = false;
  let ftsIndexSize = 0;
  let ftsDocCount: number | null = null;
  try {
    const cache = findFtsCacheForPath(phrenPath, profile);
    ftsIndexOk = cache.exists;
    ftsIndexSize = cache.sizeBytes ?? 0;
    if (!ftsIndexOk) {
      const db = await buildIndex(phrenPath, profile || undefined);
      const healthRow = queryRows(db, "SELECT count(*) FROM docs", []);
      const count = Number((healthRow?.[0]?.[0] as number | string | undefined) ?? 0);
      if (Number.isFinite(count) && count >= 0) {
        ftsIndexOk = true;
        ftsDocCount = count;
      }
    }
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] statusFtsIndex: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  const ftsLabel = ftsIndexOk
    ? `${GREEN}ok${RESET} ${DIM}(${ftsIndexSize > 0 ? `${(ftsIndexSize / 1024).toFixed(0)} KB` : `${ftsDocCount ?? 0} docs`})${RESET}`
    : `${YELLOW}not built${RESET} ${DIM}(run a search to build)${RESET}`;
  console.log(`  ${DIM}fts${RESET}      ${ftsLabel}`);

  try {
    const { getOllamaUrl, checkOllamaAvailable, checkModelAvailable, getEmbeddingModel } = await import("./shared-ollama.js");
    const { getEmbeddingCache, formatEmbeddingCoverage } = await import("./shared-embedding-cache.js");
    const ollamaUrl = getOllamaUrl();
    if (!ollamaUrl) {
      console.log(`  ${DIM}semantic${RESET} ${DIM}disabled (optional)${RESET}`);
    } else {
      const available = await checkOllamaAvailable();
      if (!available) {
        console.log(`  ${DIM}semantic${RESET} ${YELLOW}offline${RESET} ${DIM}(${ollamaUrl})${RESET}`);
      } else {
        const modelReady = await checkModelAvailable();
        const model = getEmbeddingModel();
        if (!modelReady) {
          console.log(`  ${DIM}semantic${RESET} ${YELLOW}model missing${RESET} ${DIM}(${model})${RESET}`);
        } else {
          const cache = getEmbeddingCache(phrenPath);
          await cache.load().catch(() => {});
          const coverage = cache.coverage(listIndexedDocumentPaths(phrenPath, profile || undefined));
          console.log(`  ${DIM}semantic${RESET} ${GREEN}ready${RESET} ${DIM}(${model}; ${formatEmbeddingCoverage(coverage)})${RESET}`);
        }
      }
    }
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] statusSemantic: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Agent integration status
  function hasPhrenEntry(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return raw.includes('"phren"') || raw.includes("'phren'") || raw.includes('"phren"') || raw.includes("'phren'");
    } catch (err: unknown) {
      if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] hasPhrenEntry: ${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  }
  function agentConfigured(candidates: string[]): boolean {
    return candidates.some(hasPhrenEntry);
  }
  const home = homeDir();
  const agentChecks: { name: string; configured: boolean }[] = manifest?.installMode === "project-local" && manifest.workspaceRoot ? [
    {
      name: "VS Code (workspace)",
      configured: fs.existsSync(path.join(manifest.workspaceRoot, ".vscode", "mcp.json")),
    },
  ] : [
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
    console.log(`  ${DIM}agents${RESET}   ${GREEN}${configuredAgents.join(", ")}${RESET}`);
  }
  if (missingAgents.length > 0) {
    console.log(`  ${DIM}          Not configured: ${missingAgents.join(", ")} — run phren init to add${RESET}`);
  }

  // Stats
  const projectDirs = getProjectDirs(phrenPath, profile);
  let totalFindings = 0;
  let totalTask = 0;
  let totalQueue = 0;

  for (const dir of projectDirs) {
    const projName = path.basename(dir);
    totalFindings += countBullets(path.join(phrenPath, projName, "FINDINGS.md"));
    const taskPath = resolveTaskFilePath(phrenPath, projName);
    if (taskPath) totalTask += countBullets(taskPath);
    totalQueue += countQueueItems(phrenPath, projName);
  }

  console.log(`\n  ${DIM}phren holds${RESET}  ${projectDirs.length} projects, ${totalFindings} fragments, ${totalTask} tasks, ${totalQueue} queued`);

  const gitTarget = manifest?.installMode === "project-local" && manifest.workspaceRoot ? manifest.workspaceRoot : phrenPath;
  const isGitRepo = runGit(gitTarget, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const hasOriginRemote = isGitRepo && Boolean(runGit(gitTarget, ["remote", "get-url", "origin"]));
  const runtime = readRuntimeHealth(phrenPath);
  if (manifest?.installMode === "project-local") {
    console.log(`\n  ${DIM}sync${RESET}     workspace-managed`);
    console.log(`           auto-save ${runtime.lastAutoSave?.status || "n/a"}`);
  } else if (isGitRepo && !hasOriginRemote) {
    console.log(`\n  ${DIM}sync${RESET}     local-only ${DIM}(no git remote)${RESET}`);
    console.log(`           auto-save ${runtime.lastAutoSave?.status || "n/a"}`);
    console.log(`           local commits ${runtime.lastSync?.unsyncedCommits ?? 0}`);
  } else {
    console.log(`\n  ${DIM}sync${RESET}     auto-save ${runtime.lastAutoSave?.status || "n/a"}`);
    console.log(`           last pull ${runtime.lastSync?.lastPullStatus || "n/a"}${runtime.lastSync?.lastPullAt ? ` @ ${runtime.lastSync.lastPullAt}` : ""}`);
    console.log(`           last push ${runtime.lastSync?.lastPushStatus || "n/a"}${runtime.lastSync?.lastPushAt ? ` @ ${runtime.lastSync.lastPushAt}` : ""}`);
    console.log(`           unsynced commits ${runtime.lastSync?.unsyncedCommits ?? 0}`);
    if (runtime.lastSync?.lastPushDetail) {
      console.log(`           push detail ${runtime.lastSync.lastPushDetail}`);
    }
  }

  // Recent changes (git log)
  if (isGitRepo) {
    const log = runGit(gitTarget, ["log", "--oneline", "-5", "--no-decorate"]);
    if (log) {
      console.log(`\n  ${DIM}recent${RESET}`);
      for (const line of log.split("\n")) {
        console.log(`    ${DIM}${line}${RESET}`);
      }
    }
    const dirty = runGit(gitTarget, ["status", "--porcelain"]);
    if (dirty) {
      const count = dirty.split("\n").filter(Boolean).length;
      console.log(`    ${YELLOW}${count} uncommitted change(s)${RESET}`);
    }
  } else {
    console.log(`\n  ${DIM}${gitTarget} is not a git repo${RESET}`);
  }

  // Telemetry
  const telemetry = getTelemetrySummary(phrenPath);
  const firstLine = telemetry.split("\n")[0];
  console.log(`\n  ${BOLD}${firstLine}${RESET}`);

  console.log("");
}
