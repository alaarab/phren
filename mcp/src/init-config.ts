/**
 * Provider-specific MCP configuration backends.
 * Handles IDE/tool config files for Claude, VS Code, Cursor, Copilot CLI, and Codex.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { buildLifecycleCommands } from "./hooks.js";
import {
  EXEC_TIMEOUT_QUICK_MS,
  isRecord,
} from "./shared.js";
import { isFeatureEnabled, errorMessage } from "./utils.js";

import { getMcpEnabledPreference, getHooksEnabledPreference } from "./init-preferences.js";
import { resolveEntryScript, VERSION } from "./init-shared.js";

export type McpConfigStatus = "installed" | "already_configured" | "disabled" | "already_disabled";
export type McpRootKey = "mcpServers" | "servers";
export type ToolStatus = McpConfigStatus | "no_settings" | "no_vscode" | "no_cursor" | "no_copilot" | "no_codex";

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

type HookEventName = "UserPromptSubmit" | "Stop" | "SessionStart" | "PostToolUse";
type HookMap = Partial<Record<HookEventName, HookEntry[]>> & Record<string, unknown>;
type JsonObject = Record<string, unknown> & {
  hooks?: HookMap;
  mcpServers?: Record<string, unknown>;
  servers?: Record<string, unknown>;
};

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

function getObjectProp(value: JsonObject, key: string): JsonObject | undefined {
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

export function patchJsonFile(filePath: string, patch: (data: JsonObject) => void) {
  let data: JsonObject = {};
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!isRecord(parsed)) throw new Error("top-level JSON value must be an object");
      data = parsed;
    } catch (err) {
      throw new Error(`Malformed JSON in ${filePath}: ${errorMessage(err)}`);
    }
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  patch(data);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function commandExists(cmd: string): boolean {
  try {
    const whichCmd = process.platform === "win32" ? "where.exe" : "which";
    execFileSync(whichCmd, [cmd], { stdio: ["ignore", "ignore", "ignore"], timeout: EXEC_TIMEOUT_QUICK_MS });
    return true;
  } catch {
    return false;
  }
}

function pickExistingFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeWindowsPathToWsl(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (input.startsWith("/")) return input;
  const match = input.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return input;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

function uniqStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v && v.trim()))));
}

function buildMcpServerConfig(cortexPath: string) {
  const entryScript = resolveEntryScript();
  if (entryScript && fs.existsSync(entryScript)) {
    return {
      command: "node",
      args: [entryScript, cortexPath],
    };
  }
  return {
    command: "npx",
    args: ["-y", `@alaarab/cortex@${VERSION}`, cortexPath],
  };
}

export function upsertMcpServer(
  data: JsonObject,
  mcpEnabled: boolean,
  preferredRoot: McpRootKey,
  cortexPath: string
): McpConfigStatus {
  const mcpServers = getObjectProp(data, "mcpServers");
  const servers = getObjectProp(data, "servers");
  const hadMcp = Boolean(mcpServers?.cortex || servers?.cortex);
  if (mcpEnabled) {
    const staleKey: McpRootKey = preferredRoot === "mcpServers" ? "servers" : "mcpServers";
    const staleRoot = getObjectProp(data, staleKey);
    if (staleRoot?.cortex) {
      delete staleRoot.cortex;
      if (Object.keys(staleRoot).length === 0) delete data[staleKey];
    }
    let preferredRootValue = getObjectProp(data, preferredRoot);
    if (!preferredRootValue) {
      preferredRootValue = {};
      data[preferredRoot] = preferredRootValue;
    }
    preferredRootValue.cortex = buildMcpServerConfig(cortexPath);
    return hadMcp ? "already_configured" : "installed";
  }

  if (mcpServers?.cortex) delete mcpServers.cortex;
  if (servers?.cortex) delete servers.cortex;
  return hadMcp ? "disabled" : "already_disabled";
}

function configureMcpAtPath(
  filePath: string,
  mcpEnabled: boolean,
  preferredRoot: McpRootKey,
  cortexPath: string
): McpConfigStatus {
  if (!mcpEnabled && !fs.existsSync(filePath)) return "already_disabled";
  let status: McpConfigStatus = "already_disabled";
  patchJsonFile(filePath, (data) => {
    status = upsertMcpServer(data, mcpEnabled, preferredRoot, cortexPath);
  });
  return status;
}

/**
 * Read/write a TOML config file to upsert or remove [mcp_servers.cortex].
 * Lightweight: preserves all other content, only touches the cortex section.
 */
function patchTomlMcpServer(
  filePath: string,
  mcpEnabled: boolean,
  cortexPath: string
): McpConfigStatus {
  let content = "";
  const existed = fs.existsSync(filePath);
  if (existed) {
    content = fs.readFileSync(filePath, "utf8");
  } else if (!mcpEnabled) {
    return "already_disabled";
  }

  const cfg = buildMcpServerConfig(cortexPath);
  const escToml = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const argsToml = "[" + cfg.args.map((a: string) => `"${escToml(a)}"`).join(", ") + "]";
  const newSection = `[mcp_servers.cortex]\ncommand = "${escToml(cfg.command)}"\nargs = ${argsToml}\nstartup_timeout_sec = 30`;

  const sectionRe = /^\[mcp_servers\.cortex\]\s*\n(?:(?!\[)[^\n]*\n?)*/m;
  const hadSection = sectionRe.test(content);

  if (mcpEnabled) {
    if (hadSection) {
      content = content.replace(sectionRe, newSection + "\n");
      fs.writeFileSync(filePath, content);
      return "already_configured";
    }
    if (!existed) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    const sep = content.length > 0 && !content.endsWith("\n\n") ? (content.endsWith("\n") ? "\n" : "\n\n") : "";
    content += sep + newSection + "\n";
    fs.writeFileSync(filePath, content);
    return "installed";
  }

  if (!hadSection) return "already_disabled";
  content = content.replace(sectionRe, "");
  content = content.replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(filePath, content);
  return "disabled";
}

export function removeTomlMcpServer(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, "utf8");
  const sectionRe = /^\[mcp_servers\.cortex\]\s*\n(?:(?!\[)[^\n]*\n?)*/m;
  if (!sectionRe.test(content)) return false;
  content = content.replace(sectionRe, "").replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(filePath, content);
  return true;
}

export function removeMcpServerAtPath(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  let removed = false;
  patchJsonFile(filePath, (data) => {
    if (data.mcpServers?.cortex) {
      delete data.mcpServers.cortex;
      removed = true;
    }
    if (data.servers?.cortex) {
      delete data.servers.cortex;
      removed = true;
    }
  });
  return removed;
}

export function isCortexCommand(command: string): boolean {
  // Detect CORTEX_PATH= env var prefix (present in all lifecycle hook commands)
  if (/\bCORTEX_PATH=/.test(command)) return true;
  // Detect npx/@alaarab/cortex package references
  if (command.includes("@alaarab/cortex")) return true;
  // Detect bare "cortex" executable segment
  const segments = command.split(/[/\\\s]+/);
  if (segments.some(seg => seg === "cortex" || seg.startsWith("cortex@") || seg.startsWith("@alaarab/cortex"))) return true;
  // Also match commands that include cortex hook subcommands (used when installed via absolute path)
  const HOOK_MARKERS = ["hook-prompt", "hook-stop", "hook-session-start", "hook-tool"];
  if (HOOK_MARKERS.some(m => command.includes(m))) return true;
  return false;
}

export function configureClaude(cortexPath: string, opts: { mcpEnabled?: boolean; hooksEnabled?: boolean } = {}): McpConfigStatus {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  const entryScript = resolveEntryScript();
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const hooksEnabled = opts.hooksEnabled ?? getHooksEnabledPreference(cortexPath);
  const lifecycle = buildLifecycleCommands(cortexPath);
  let status: McpConfigStatus = "already_disabled";

  if (fs.existsSync(claudeJsonPath)) {
    patchJsonFile(claudeJsonPath, (data) => {
      status = upsertMcpServer(data, mcpEnabled, "mcpServers", cortexPath);
    });
  }

  patchJsonFile(settingsPath, (data) => {
    const settingsStatus = upsertMcpServer(data, mcpEnabled, "mcpServers", cortexPath);
    if (status === "already_disabled") status = settingsStatus;

    const hooksMap = isRecord(data.hooks) ? data.hooks as HookMap : (data.hooks = {} as HookMap);

    const upsertCortexHook = (eventName: "UserPromptSubmit" | "Stop" | "SessionStart" | "PostToolUse", hookBody: { type: string; command: string; timeout?: number }) => {
      if (!Array.isArray(hooksMap[eventName])) hooksMap[eventName] = [];
      const eventHooks = hooksMap[eventName] as HookEntry[];
      const marker = eventName === "UserPromptSubmit" ? "hook-prompt"
        : eventName === "Stop" ? "hook-stop"
        : eventName === "PostToolUse" ? "hook-tool"
        : "hook-session-start";
      const legacyMarker = eventName === "Stop" ? "auto-save" : eventName === "SessionStart" ? "doctor --fix" : "hook-prompt";
      // Find the HookEntry containing a cortex hook command
      const existingEntryIdx = eventHooks.findIndex(
        (h: HookEntry) => h?.hooks?.some(
          (hook) =>
            typeof hook?.command === "string" &&
            (
              hook.command.includes(marker) ||
              hook.command.includes(legacyMarker) ||
              isCortexCommand(hook.command)
            )
        )
      );
      if (existingEntryIdx >= 0) {
        // Only rewrite the matching inner hook item; preserve sibling non-cortex hooks
        const entry = eventHooks[existingEntryIdx];
        const innerIdx = (entry.hooks ?? []).findIndex(
          (hook) =>
            typeof hook?.command === "string" &&
            (
              hook.command.includes(marker) ||
              hook.command.includes(legacyMarker) ||
              isCortexCommand(hook.command)
            )
        );
        if (innerIdx >= 0 && entry.hooks) {
          entry.hooks[innerIdx] = hookBody;
        } else {
          // No matching inner hook found; append our hook body
          if (!entry.hooks) entry.hooks = [];
          entry.hooks.push(hookBody);
        }
      } else {
        eventHooks.push({ matcher: "", hooks: [hookBody] });
      }
    };

    const toolHookEnabled = hooksEnabled && isFeatureEnabled("CORTEX_FEATURE_TOOL_HOOK", false);

    if (hooksEnabled) {
      upsertCortexHook("UserPromptSubmit", {
        type: "command",
        command: lifecycle.userPromptSubmit || `node "${entryScript}" hook-prompt`,
        timeout: 3,
      });

      upsertCortexHook("Stop", {
        type: "command",
        command: lifecycle.stop,
      });

      upsertCortexHook("SessionStart", {
        type: "command",
        command: lifecycle.sessionStart,
      });

      if (toolHookEnabled) {
        upsertCortexHook("PostToolUse", {
          type: "command",
          command: lifecycle.hookTool,
        });
      }
    } else {
      for (const hookEvent of ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"] as const) {
        const hooks = hooksMap[hookEvent] as HookEntry[] | undefined;
        if (!Array.isArray(hooks)) continue;
        hooksMap[hookEvent] = hooks.filter(
          (h: HookEntry) => !h.hooks?.some(
            (hook) => typeof hook.command === "string" && isCortexCommand(hook.command)
          )
        );
      }
    }
  });
  return status;
}

let _vscodeProbeCache: { targetDir: string | null; installed: boolean } | null = null;

/** Reset the VS Code path probe cache (for testing). */
export function resetVSCodeProbeCache() { _vscodeProbeCache = null; }

function probeVSCodePath(): { targetDir: string | null; installed: boolean } {
  if (_vscodeProbeCache) return _vscodeProbeCache;
  const home = os.homedir();
  const userProfile = normalizeWindowsPathToWsl(process.env.USERPROFILE);
  const username = process.env.USERNAME;
  const userProfileRoaming = userProfile ? path.join(userProfile, "AppData", "Roaming", "Code", "User") : undefined;
  const guessedWindowsRoaming = !userProfile && username
    ? path.join("/mnt/c", "Users", username, "AppData", "Roaming", "Code", "User")
    : undefined;
  const candidates = uniqStrings([
    userProfileRoaming,
    guessedWindowsRoaming,
    path.join(home, ".config", "Code", "User"),
    path.join(home, ".vscode-server", "data", "User"),
    path.join(home, "Library", "Application Support", "Code", "User"),
    path.join(home, "AppData", "Roaming", "Code", "User"),
  ]);
  const existing = candidates.find((d) => fs.existsSync(d));
  const installed =
    Boolean(existing) ||
    commandExists("code") ||
    Boolean(
      userProfile &&
      (
        fs.existsSync(path.join(userProfile, "AppData", "Local", "Programs", "Microsoft VS Code")) ||
        fs.existsSync(path.join(userProfile, "AppData", "Roaming", "Code"))
      )
    );
  const targetDir = installed
    ? (existing || userProfileRoaming || path.join(home, ".config", "Code", "User"))
    : null;
  _vscodeProbeCache = { targetDir, installed };
  return _vscodeProbeCache;
}

export function configureVSCode(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): McpConfigStatus | "no_vscode" {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const probe = probeVSCodePath();
  if (!probe.installed || !probe.targetDir) return "no_vscode";
  const mcpFile = path.join(probe.targetDir, "mcp.json");
  return configureMcpAtPath(mcpFile, mcpEnabled, "servers", cortexPath);
}

export function configureCursorMcp(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const home = os.homedir();
  const candidates = [
    path.join(home, ".cursor", "mcp.json"),
    path.join(home, ".config", "Cursor", "User", "mcp.json"),
    path.join(home, "Library", "Application Support", "Cursor", "User", "mcp.json"),
    path.join(home, "AppData", "Roaming", "Cursor", "User", "mcp.json"),
  ];
  const existing = pickExistingFile(candidates);
  const cursorInstalled =
    Boolean(existing) ||
    fs.existsSync(path.join(home, ".cursor")) ||
    fs.existsSync(path.join(home, ".config", "Cursor")) ||
    fs.existsSync(path.join(home, "Library", "Application Support", "Cursor")) ||
    fs.existsSync(path.join(home, "AppData", "Roaming", "Cursor")) ||
    commandExists("cursor");
  if (!cursorInstalled) return "no_cursor";
  return configureMcpAtPath(existing || candidates[0], mcpEnabled, "mcpServers", cortexPath);
}

export function configureCopilotMcp(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const home = os.homedir();
  const candidates = [
    path.join(home, ".copilot", "mcp-config.json"),
    path.join(home, ".github", "mcp.json"),
    path.join(home, ".config", "github-copilot", "mcp.json"),
    path.join(home, "Library", "Application Support", "github-copilot", "mcp.json"),
    path.join(home, "AppData", "Roaming", "github-copilot", "mcp.json"),
  ];
  const existing = pickExistingFile(candidates);
  const copilotInstalled =
    Boolean(existing) ||
    fs.existsSync(path.join(home, ".copilot")) ||
    fs.existsSync(path.join(home, ".github")) ||
    fs.existsSync(path.join(home, ".config", "github-copilot")) ||
    fs.existsSync(path.join(home, "Library", "Application Support", "github-copilot")) ||
    fs.existsSync(path.join(home, "AppData", "Roaming", "github-copilot")) ||
    commandExists("gh");
  if (!copilotInstalled) return "no_copilot";
  const copilotCliConfig = candidates[0];
  let status: McpConfigStatus = "already_disabled";
  if (fs.existsSync(path.join(home, ".copilot"))) {
    status = configureMcpAtPath(copilotCliConfig, mcpEnabled, "mcpServers", cortexPath);
  }
  if (existing && existing !== copilotCliConfig) {
    status = configureMcpAtPath(existing, mcpEnabled, "mcpServers", cortexPath);
  }
  if (!fs.existsSync(path.join(home, ".copilot")) && !existing) {
    status = configureMcpAtPath(copilotCliConfig, mcpEnabled, "mcpServers", cortexPath);
  }
  return status;
}

export function configureCodexMcp(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const home = os.homedir();
  const tomlPath = path.join(home, ".codex", "config.toml");
  const jsonCandidates = [
    path.join(home, ".codex", "config.json"),
    path.join(home, ".codex", "mcp.json"),
    path.join(cortexPath, "codex.json"),
  ];
  const codexInstalled =
    fs.existsSync(tomlPath) ||
    Boolean(pickExistingFile(jsonCandidates)) ||
    fs.existsSync(path.join(home, ".codex")) ||
    commandExists("codex");
  if (!codexInstalled) return "no_codex";

  if (fs.existsSync(tomlPath) || !pickExistingFile(jsonCandidates)) {
    return patchTomlMcpServer(tomlPath, mcpEnabled, cortexPath);
  }
  const existing = pickExistingFile(jsonCandidates)!;
  return configureMcpAtPath(existing, mcpEnabled, "mcpServers", cortexPath);
}

export function logMcpTargetStatus(tool: string, status: string, phase: "Configured" | "Updated" = "Configured") {
  const text: Record<string, string> = {
    installed: `${phase} ${tool} MCP`,
    already_configured: `${tool} MCP already configured`,
    disabled: `${tool} MCP disabled`,
    already_disabled: `${tool} MCP already disabled`,
    no_settings: `${tool} settings not found`,
    no_vscode: `${tool} not detected`,
    no_cursor: `${tool} not detected`,
    no_copilot: `${tool} not detected`,
    no_codex: `${tool} not detected`,
  };
  if (text[status]) log(`  ${text[status]}`);
}
