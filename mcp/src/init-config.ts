/**
 * Provider-specific MCP configuration backends.
 * Handles IDE/tool config files for Claude, VS Code, Cursor, Copilot CLI, and Codex.
 */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { buildLifecycleCommands } from "./hooks.js";
import {
  EXEC_TIMEOUT_QUICK_MS,
  isRecord,
  hookConfigPath,
  homePath,
} from "./shared.js";
import { isFeatureEnabled, errorMessage } from "./utils.js";
import {
  probeVsCodeConfig,
  resolveCodexMcpConfig,
  resolveCopilotMcpConfig,
  resolveCursorMcpConfig,
} from "./provider-adapters.js";

import { getMcpEnabledPreference, getHooksEnabledPreference } from "./init-preferences.js";
import { resolveEntryScript, VERSION } from "./init-shared.js";

export type McpConfigStatus = "installed" | "already_configured" | "disabled" | "already_disabled";
export type McpRootKey = "mcpServers";
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
};

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

function getObjectProp(value: JsonObject, key: string): JsonObject | undefined {
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
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
  atomicWriteText(filePath, JSON.stringify(data, null, 2) + "\n");
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

function upsertMcpServer(
  data: JsonObject,
  mcpEnabled: boolean,
  preferredRoot: McpRootKey,
  cortexPath: string
): McpConfigStatus {
  const mcpServers = getObjectProp(data, "mcpServers");
  const hadMcp = Boolean(mcpServers?.cortex);
  if (mcpEnabled) {
    let preferredRootValue = getObjectProp(data, preferredRoot);
    if (!preferredRootValue) {
      preferredRootValue = {};
      data[preferredRoot] = preferredRootValue;
    }
    preferredRootValue.cortex = buildMcpServerConfig(cortexPath);
    return hadMcp ? "already_configured" : "installed";
  }

  if (mcpServers?.cortex) delete mcpServers.cortex;
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
      atomicWriteText(filePath, content);
      return "already_configured";
    }
    if (!existed) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    const sep = content.length > 0 && !content.endsWith("\n\n") ? (content.endsWith("\n") ? "\n" : "\n\n") : "";
    content += sep + newSection + "\n";
    atomicWriteText(filePath, content);
    return "installed";
  }

  if (!hadSection) return "already_disabled";
  content = content.replace(sectionRe, "");
  content = content.replace(/\n{3,}/g, "\n\n");
  atomicWriteText(filePath, content);
  return "disabled";
}

export function removeTomlMcpServer(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, "utf8");
  const sectionRe = /^\[mcp_servers\.cortex\]\s*\n(?:(?!\[)[^\n]*\n?)*/m;
  if (!sectionRe.test(content)) return false;
  content = content.replace(sectionRe, "").replace(/\n{3,}/g, "\n\n");
  atomicWriteText(filePath, content);
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
  const settingsPath = hookConfigPath("claude");
  const claudeJsonPath = homePath(".claude.json");
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
      // Find the HookEntry containing a cortex hook command
      const existingEntryIdx = eventHooks.findIndex(
        (h: HookEntry) => h?.hooks?.some(
          (hook) =>
            typeof hook?.command === "string" &&
            (
              hook.command.includes(marker) ||
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
  _vscodeProbeCache = probeVsCodeConfig(commandExists);
  return _vscodeProbeCache;
}

export function configureVSCode(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): McpConfigStatus | "no_vscode" {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const probe = probeVSCodePath();
  if (!probe.installed || !probe.targetDir) return "no_vscode";
  const mcpFile = path.join(probe.targetDir, "mcp.json");
  return configureMcpAtPath(mcpFile, mcpEnabled, "mcpServers", cortexPath);
}

export function configureCursorMcp(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const resolved = resolveCursorMcpConfig(commandExists);
  if (!resolved.installed) return "no_cursor";
  return configureMcpAtPath(resolved.target, mcpEnabled, "mcpServers", cortexPath);
}

export function configureCopilotMcp(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const resolved = resolveCopilotMcpConfig(commandExists);
  if (!resolved.installed) return "no_copilot";
  let status: McpConfigStatus = "already_disabled";
  if (resolved.hasCliDir) {
    status = configureMcpAtPath(resolved.cliConfig, mcpEnabled, "mcpServers", cortexPath);
  }
  if (resolved.existing && resolved.existing !== resolved.cliConfig) {
    status = configureMcpAtPath(resolved.existing, mcpEnabled, "mcpServers", cortexPath);
  }
  if (!resolved.hasCliDir && !resolved.existing) {
    status = configureMcpAtPath(resolved.cliConfig, mcpEnabled, "mcpServers", cortexPath);
  }
  return status;
}

export function configureCodexMcp(cortexPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(cortexPath);
  const resolved = resolveCodexMcpConfig(cortexPath, commandExists);
  if (!resolved.installed) return "no_codex";

  if (resolved.preferToml) {
    return patchTomlMcpServer(resolved.tomlPath, mcpEnabled, cortexPath);
  }
  return configureMcpAtPath(resolved.existingJson!, mcpEnabled, "mcpServers", cortexPath);
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
