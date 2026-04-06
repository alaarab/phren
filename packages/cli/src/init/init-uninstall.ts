/**
 * Uninstall logic for phren: removes MCP configs, hooks, symlinks, and data.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import {
  atomicWriteText,
  debugLog,
  isRecord,
  hookConfigPath,
  homeDir,
  homePath,
  findPhrenPath,
  getProjectDirs,
  readRootManifest,
} from "../shared.js";
import { errorMessage } from "../utils.js";
import { FINDINGS_FILENAME } from "../data/access.js";
import {
  codexJsonCandidates,
  copilotMcpCandidates,
  cursorMcpCandidates,
  vscodeMcpCandidates,
} from "../provider-adapters.js";
import {
  removeMcpServerAtPath,
  removeTomlMcpServer,
  isPhrenCommand,
  patchJsonFile,
} from "./config.js";
import type { HookEntry, HookMap } from "./config.js";
import { DEFAULT_PHREN_PATH, log } from "./shared.js";

const PHREN_NPM_PACKAGE_NAME = "@phren/cli";

interface SyncCommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

function getNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runSyncCommand(command: string, args: string[]): SyncCommandResult {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (err: unknown) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: errorMessage(err),
    };
  }
}

function shouldUninstallCurrentGlobalPackage(): boolean {
  // Always attempt to remove the global package if it exists, regardless of
  // whether the uninstaller was invoked from the global install or a local repo.
  const npmRootResult = runSyncCommand(getNpmCommand(), ["root", "-g"]);
  if (!npmRootResult.ok) return false;
  const npmRoot = npmRootResult.stdout.trim();
  if (!npmRoot) return false;
  const globalPkgPath = path.join(npmRoot, PHREN_NPM_PACKAGE_NAME);
  return fs.existsSync(globalPkgPath);
}

function uninstallCurrentGlobalPackage(): void {
  const result = runSyncCommand(getNpmCommand(), ["uninstall", "-g", PHREN_NPM_PACKAGE_NAME]);
  if (result.ok) {
    log(`  Removed global npm package (${PHREN_NPM_PACKAGE_NAME})`);
    return;
  }

  const detail = result.stderr.trim() || result.stdout.trim() || (result.status === null ? "failed to start command" : `exit code ${result.status}`);
  log(`  Warning: could not remove global npm package (${PHREN_NPM_PACKAGE_NAME})`);
  debugLog(`uninstall: global npm cleanup failed: ${detail}`);
}

// Agent skill directories to sweep for symlinks during uninstall
function agentSkillDirs(): string[] {
  const home = homeDir();
  return [
    homePath(".claude", "skills"),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".copilot", "skills"),
    path.join(home, ".codex", "skills"),
  ];
}

// Remove skill symlinks that resolve inside phrenPath. Only touches symlinks, never regular files.
function sweepSkillSymlinks(phrenPath: string): void {
  const resolvedPhren = path.resolve(phrenPath);
  for (const dir of agentSkillDirs()) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err: unknown) {
      debugLog(`sweepSkillSymlinks: readdirSync failed for ${dir}: ${errorMessage(err)}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const target = fs.realpathSync(fullPath);
        if (target.startsWith(resolvedPhren + path.sep) || target === resolvedPhren) {
          fs.unlinkSync(fullPath);
          log(`  Removed skill symlink: ${fullPath}`);
        }
      } catch {
        // Broken symlink (target no longer exists) — clean it up
        try {
          fs.unlinkSync(fullPath);
          log(`  Removed broken skill symlink: ${fullPath}`);
        } catch (err2: unknown) {
          debugLog(`sweepSkillSymlinks: could not remove broken symlink ${fullPath}: ${errorMessage(err2)}`);
        }
      }
    }

    // Remove phren-generated manifest files from the skills parent directory
    const parentDir = path.dirname(dir);
    for (const manifestFile of ["skill-manifest.json", "skill-commands.json"]) {
      const manifestPath = path.join(parentDir, manifestFile);
      try {
        if (fs.existsSync(manifestPath)) {
          fs.unlinkSync(manifestPath);
          log(`  Removed ${manifestFile} (${manifestPath})`);
        }
      } catch (err: unknown) {
        debugLog(`sweepSkillSymlinks: could not remove ${manifestPath}: ${errorMessage(err)}`);
      }
    }
  }
}

// Filter phren hook entries from an agent hooks file. Returns true if the file was changed.
// Deletes the file if no hooks remain. `commandField` is the JSON key holding the command
// string in each hook entry (e.g. "bash" for Copilot, "command" for Codex).
function filterAgentHooks(filePath: string, commandField: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(raw) || !isRecord(raw.hooks)) return false;
    const hooks = raw.hooks as Record<string, unknown>;
    let changed = false;
    for (const event of Object.keys(hooks)) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      const filtered = entries.filter(
        (e: unknown) => !(isRecord(e) && typeof e[commandField] === "string" && isPhrenCommand(e[commandField] as string))
      );
      if (filtered.length !== entries.length) {
        hooks[event] = filtered;
        changed = true;
      }
    }
    if (!changed) return false;
    // Remove empty hook event keys
    for (const event of Object.keys(hooks)) {
      if (Array.isArray(hooks[event]) && (hooks[event] as unknown[]).length === 0) {
        delete hooks[event];
      }
    }
    if (Object.keys(hooks).length === 0) {
      fs.unlinkSync(filePath);
    } else {
      atomicWriteText(filePath, JSON.stringify(raw, null, 2));
    }
    return true;
  } catch (err: unknown) {
    debugLog(`filterAgentHooks: failed for ${filePath}: ${errorMessage(err)}`);
    return false;
  }
}

async function promptUninstallConfirm(phrenPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;

  // Show summary of what will be deleted
  try {
    const projectDirs = getProjectDirs(phrenPath);
    const projectCount = projectDirs.length;
    let findingCount = 0;
    for (const dir of projectDirs) {
      const findingsFile = path.join(dir, FINDINGS_FILENAME);
      if (fs.existsSync(findingsFile)) {
        const content = fs.readFileSync(findingsFile, "utf8");
        findingCount += content.split("\n").filter((l) => l.startsWith("- ")).length;
      }
    }
    log(`\n  Will delete: ${phrenPath}`);
    log(`  Contains: ${projectCount} project(s), ~${findingCount} finding(s)`);
  } catch (err: unknown) {
    debugLog(`promptUninstallConfirm: summary failed: ${errorMessage(err)}`);
    log(`\n  Will delete: ${phrenPath}`);
  }

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\nThis will permanently delete ${phrenPath} and all phren data. Type 'yes' to confirm: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

export async function runUninstall(opts: { yes?: boolean } = {}) {
  const phrenPath = findPhrenPath();
  const manifest = phrenPath ? readRootManifest(phrenPath) : null;
  if (manifest?.installMode === "project-local" && phrenPath) {
    log("\nUninstalling project-local phren...\n");
    const workspaceRoot = manifest.workspaceRoot || path.dirname(phrenPath);
    const workspaceMcp = path.join(workspaceRoot, ".vscode", "mcp.json");
    try {
      if (removeMcpServerAtPath(workspaceMcp)) {
        log(`  Removed phren from VS Code workspace MCP config (${workspaceMcp})`);
      }
    } catch (err: unknown) {
      debugLog(`uninstall local vscode cleanup failed: ${errorMessage(err)}`);
    }
    fs.rmSync(phrenPath, { recursive: true, force: true });
    log(`  Removed ${phrenPath}`);
    log("\nProject-local phren uninstalled.");
    return;
  }

  log("\nUninstalling phren...\n");
  const shouldRemoveGlobalPackage = shouldUninstallCurrentGlobalPackage();

  // Confirmation prompt (shared-mode only — project-local is low-stakes)
  if (!opts.yes) {
    const confirmed = phrenPath
      ? await promptUninstallConfirm(phrenPath)
      : (process.stdin.isTTY && process.stdout.isTTY
        ? await (async () => {
          const readline = await import("readline");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          return new Promise<boolean>((resolve) => {
            rl.question("This will remove all phren config and hooks. Type 'yes' to confirm: ", (answer) => {
              rl.close();
              resolve(answer.trim().toLowerCase() === "yes");
            });
          });
        })()
        : true);
    if (!confirmed) {
      log("Uninstall cancelled.");
      return;
    }
  }

  const home = homeDir();
  const machineFile = (await import("../machine-identity.js")).machineFilePath();
  const settingsPath = hookConfigPath("claude");

  // Remove from Claude Code ~/.claude.json (where MCP servers are actually read)
  const claudeJsonPath = homePath(".claude.json");
  if (fs.existsSync(claudeJsonPath)) {
    try {
      if (removeMcpServerAtPath(claudeJsonPath)) {
        log(`  Removed phren MCP server from ~/.claude.json`);
      }
    } catch (e) {
      log(`  Warning: could not update ~/.claude.json (${e})`);
    }
  }

  // Remove from Claude Code settings.json
  if (fs.existsSync(settingsPath)) {
    try {
      patchJsonFile(settingsPath, (data) => {
        const hooksMap = isRecord(data.hooks) ? data.hooks as HookMap : (data.hooks = {} as HookMap);
        // Remove MCP server
        if (data.mcpServers?.phren) {
          delete data.mcpServers.phren;
          log(`  Removed phren MCP server from Claude Code settings`);
        }

        // Remove hooks containing phren references
        for (const hookEvent of ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"] as const) {
          const hooks = hooksMap[hookEvent] as HookEntry[] | undefined;
          if (!Array.isArray(hooks)) continue;
          const before = hooks.length;
          hooksMap[hookEvent] = hooks.filter(
            (h: HookEntry) => !h.hooks?.some(
              (hook) => typeof hook.command === "string" && isPhrenCommand(hook.command)
            )
          );
          const removed = before - (hooksMap[hookEvent] as HookEntry[]).length;
          if (removed > 0) log(`  Removed ${removed} phren hook(s) from ${hookEvent}`);
        }
      });
    } catch (e) {
      log(`  Warning: could not update Claude Code settings (${e})`);
    }
  } else {
    log(`  Claude Code settings not found at ${settingsPath} — skipping`);
  }

  // Remove from VS Code mcp.json
  const vsCandidates = vscodeMcpCandidates().map((dir) => path.join(dir, "mcp.json"));
  for (const mcpFile of vsCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed phren from VS Code MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Cursor MCP config
  const cursorCandidates = cursorMcpCandidates();
  for (const mcpFile of cursorCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed phren from Cursor MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Copilot CLI MCP config
  const copilotCandidates = copilotMcpCandidates();
  for (const mcpFile of copilotCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed phren from Copilot CLI MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Codex MCP config (TOML + JSON)
  const codexToml = path.join(home, ".codex", "config.toml");
  try {
    if (removeTomlMcpServer(codexToml)) {
      log(`  Removed phren from Codex MCP config (${codexToml})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${codexToml}: ${errorMessage(err)}`); }

  const codexCandidates = codexJsonCandidates((process.env.PHREN_PATH) || DEFAULT_PHREN_PATH);
  for (const mcpFile of codexCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed phren from Codex MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove phren entries from Copilot hooks file (filter, don't bulk-delete)
  const copilotHooksFile = hookConfigPath("copilot", (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH);
  try {
    if (filterAgentHooks(copilotHooksFile, "bash")) {
      log(`  Removed phren entries from Copilot hooks (${copilotHooksFile})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${copilotHooksFile}: ${errorMessage(err)}`); }

  // Remove phren entries from Cursor hooks file (may contain non-phren entries)
  const cursorHooksFile = hookConfigPath("cursor", (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH);
  try {
    if (fs.existsSync(cursorHooksFile)) {
      const raw = JSON.parse(fs.readFileSync(cursorHooksFile, "utf8"));
      let changed = false;
      for (const key of ["sessionStart", "beforeSubmitPrompt", "stop"]) {
        if (raw[key]?.command && typeof raw[key].command === "string" && isPhrenCommand(raw[key].command)) {
          delete raw[key];
          changed = true;
        }
      }
      if (changed) {
        atomicWriteText(cursorHooksFile, JSON.stringify(raw, null, 2));
        log(`  Removed phren entries from Cursor hooks (${cursorHooksFile})`);
      }
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${cursorHooksFile}: ${errorMessage(err)}`); }

  // Remove phren entries from Codex hooks file (filter, don't bulk-delete)
  const uninstallPhrenPath = (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  const codexHooksFile = hookConfigPath("codex", uninstallPhrenPath);
  try {
    if (filterAgentHooks(codexHooksFile, "command")) {
      log(`  Removed phren entries from Codex hooks (${codexHooksFile})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${codexHooksFile}: ${errorMessage(err)}`); }

  // Remove session wrapper scripts (written by installSessionWrapper) and CLI wrapper
  const localBinDir = path.join(home, ".local", "bin");
  for (const tool of ["copilot", "cursor", "codex", "phren"]) {
    const wrapperPath = path.join(localBinDir, tool);
    try {
      if (fs.existsSync(wrapperPath)) {
        // Only remove if it's a phren wrapper (check for PHREN_PATH marker)
        const content = fs.readFileSync(wrapperPath, "utf8");
        if (content.includes("PHREN_PATH") && content.includes("phren")) {
          fs.unlinkSync(wrapperPath);
          log(`  Removed ${tool} session wrapper (${wrapperPath})`);
        }
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${wrapperPath}: ${errorMessage(err)}`); }
  }

  try {
    if (fs.existsSync(machineFile)) {
      fs.unlinkSync(machineFile);
      log(`  Removed machine alias (${machineFile})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${machineFile}: ${errorMessage(err)}`); }

  const contextFile = homePath(".phren-context.md");
  try {
    if (fs.existsSync(contextFile)) {
      fs.unlinkSync(contextFile);
      log(`  Removed machine context file (${contextFile})`);
    }
  } catch (err: unknown) {
    debugLog(`uninstall: cleanup failed for ${contextFile}: ${errorMessage(err)}`);
  }

  // Remove global CLAUDE.md symlink (created by linkGlobal -> ~/.claude/CLAUDE.md)
  const globalClaudeLink = homePath(".claude", "CLAUDE.md");
  try {
    if (fs.lstatSync(globalClaudeLink).isSymbolicLink()) {
      fs.unlinkSync(globalClaudeLink);
      log(`  Removed global CLAUDE.md symlink (${globalClaudeLink})`);
    }
  } catch {
    // Does not exist or not a symlink — nothing to do
  }

  // Remove copilot-instructions.md symlink (created by linkGlobal -> ~/.github/copilot-instructions.md)
  const copilotInstrLink = homePath(".github", "copilot-instructions.md");
  try {
    if (fs.lstatSync(copilotInstrLink).isSymbolicLink()) {
      fs.unlinkSync(copilotInstrLink);
      log(`  Removed copilot-instructions.md symlink (${copilotInstrLink})`);
    }
  } catch {
    // Does not exist or not a symlink — nothing to do
  }

  // Sweep agent skill directories for symlinks pointing into the phren store
  if (phrenPath) {
    try {
      sweepSkillSymlinks(phrenPath);
    } catch (err: unknown) {
      debugLog(`uninstall: skill symlink sweep failed: ${errorMessage(err)}`);
    }
  }

  if (phrenPath && fs.existsSync(phrenPath)) {
    try {
      fs.rmSync(phrenPath, { recursive: true, force: true });
      log(`  Removed phren root (${phrenPath})`);
    } catch (err: unknown) {
      debugLog(`uninstall: cleanup failed for ${phrenPath}: ${errorMessage(err)}`);
      log(`  Warning: could not remove phren root (${phrenPath})`);
    }
  }

  if (shouldRemoveGlobalPackage) {
    uninstallCurrentGlobalPackage();
  }

  // Remove VS Code extension if installed
  try {
    const codeResult = execFileSync("code", ["--list-extensions"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const phrenExts = codeResult.split("\n").filter((ext) => ext.toLowerCase().includes("phren"));
    for (const ext of phrenExts) {
      const trimmed = ext.trim();
      if (!trimmed) continue;
      try {
        execFileSync("code", ["--uninstall-extension", trimmed], {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 15_000,
        });
        log(`  Removed VS Code extension (${trimmed})`);
      } catch (err: unknown) {
        debugLog(`uninstall: VS Code extension removal failed for ${trimmed}: ${errorMessage(err)}`);
      }
    }
  } catch {
    // code CLI not available — skip
  }

  log(`\nPhren config, hooks, and installed data removed.`);
  log(`Restart your agent(s) to apply changes.\n`);
}
