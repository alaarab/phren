/**
 * Provider-specific MCP configuration backends.
 * Handles IDE/tool config files for Claude, VS Code, Cursor, Copilot CLI, and Codex.
 */
import * as fs from "fs";
import * as path from "path";
import { buildLifecycleCommands, commandExists } from "../hooks.js";
import {
  isRecord,
  hookConfigPath,
  homePath,
  readRootManifest,
  atomicWriteText,
} from "../shared.js";
import { isFeatureEnabled, errorMessage } from "../utils.js";
import {
  probeVsCodeConfig,
  resolveCodexMcpConfig,
  resolveCopilotMcpConfig,
  resolveCursorMcpConfig,
} from "../provider-adapters.js";

import { getMcpEnabledPreference, getHooksEnabledPreference, readInstallPreferences, updateInstallPreferences } from "./preferences.js";
import { resolveEntryScript, log, VERSION } from "./shared.js";
import { readCustomHooks } from "../hooks.js";

export type McpConfigStatus = "installed" | "already_configured" | "disabled" | "already_disabled";
export type McpRootKey = "mcpServers" | "servers";
export type ToolStatus = McpConfigStatus | "no_settings" | "no_vscode" | "no_cursor" | "no_copilot" | "no_codex";

export interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

export type HookEventName = "UserPromptSubmit" | "Stop" | "SessionStart" | "PostToolUse";
export type HookMap = Partial<Record<HookEventName, HookEntry[]>> & Record<string, unknown>;
type JsonObject = Record<string, unknown> & {
  hooks?: HookMap;
  mcpServers?: Record<string, unknown>;
  servers?: Record<string, unknown>;
};

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
  atomicWriteText(filePath, JSON.stringify(data, null, 2) + "\n");
}

function buildMcpServerConfig(phrenPath: string) {
  const entryScript = resolveEntryScript();
  if (entryScript && fs.existsSync(entryScript)) {
    return {
      command: "node",
      args: [entryScript, phrenPath],
    };
  }
  // MCP clients spawn servers with { shell: false } on Windows, so the bare
  // `npx` name can't resolve the `npx.cmd` shim and the server fails to start.
  // Using `npx.cmd` on win32 matches how child_process resolves Windows binaries.
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", `phren@${VERSION}`, phrenPath],
  };
}

function upsertMcpServer(
  data: JsonObject,
  mcpEnabled: boolean,
  preferredRoot: McpRootKey,
  phrenPath: string
): McpConfigStatus {
  const knownRoots = ["mcpServers", "servers"] as const;
  const hadMcp = knownRoots.some((key) => Boolean(getObjectProp(data, key)?.phren));
  if (mcpEnabled) {
    let preferredRootValue = getObjectProp(data, preferredRoot);
    if (!preferredRootValue) {
      preferredRootValue = {};
      data[preferredRoot] = preferredRootValue;
    }
    preferredRootValue.phren = buildMcpServerConfig(phrenPath);
    return hadMcp ? "already_configured" : "installed";
  }

  for (const key of knownRoots) {
    const root = getObjectProp(data, key);
    if (root?.phren) delete root.phren;
  }
  return hadMcp ? "disabled" : "already_disabled";
}

function configureMcpAtPath(
  filePath: string,
  mcpEnabled: boolean,
  preferredRoot: McpRootKey,
  phrenPath: string
): McpConfigStatus {
  if (!mcpEnabled && !fs.existsSync(filePath)) return "already_disabled";
  let status: McpConfigStatus = "already_disabled";
  patchJsonFile(filePath, (data) => {
    status = upsertMcpServer(data, mcpEnabled, preferredRoot, phrenPath);
  });
  return status;
}

/**
 * Read/write a TOML config file to upsert or remove [mcp_servers.phren].
 * Lightweight: preserves all other content, only touches the phren section.
 */
function patchTomlMcpServer(
  filePath: string,
  mcpEnabled: boolean,
  phrenPath: string
): McpConfigStatus {
  let content = "";
  const existed = fs.existsSync(filePath);
  if (existed) {
    content = fs.readFileSync(filePath, "utf8");
  } else if (!mcpEnabled) {
    return "already_disabled";
  }

  const cfg = buildMcpServerConfig(phrenPath);
  const escToml = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const argsToml = "[" + cfg.args.map((a: string) => `"${escToml(a)}"`).join(", ") + "]";
  const newSection = `[mcp_servers.phren]\ncommand = "${escToml(cfg.command)}"\nargs = ${argsToml}\nstartup_timeout_sec = 30`;

  const sectionRe = /^\[mcp_servers\.phren\]\s*\n(?:(?!\[)[^\n]*\n?)*/m;
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
  const sectionRe = /^\[mcp_servers\.phren\]\s*\n(?:(?!\[)[^\n]*\n?)*/m;
  if (!sectionRe.test(content)) return false;
  content = content.replace(sectionRe, "").replace(/\n{3,}/g, "\n\n");
  atomicWriteText(filePath, content);
  return true;
}

export function removeMcpServerAtPath(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  let removed = false;
  patchJsonFile(filePath, (data) => {
    for (const key of ["mcpServers", "servers"] as const) {
      const root = data[key];
      if (isRecord(root) && root.phren) {
        delete root.phren;
        removed = true;
      }
    }
  });
  return removed;
}

export function isPhrenCommand(command: string): boolean {
  // Detect PHREN_PATH= env var prefix (present in all lifecycle hook commands)
  if (/\bPHREN_PATH=/.test(command)) return true;
  // Detect npx phren package references
  if (command.includes("phren")) return true;
  // Detect bare "phren" executable segment
  const segments = command.split(/[/\\\s]+/);
  if (segments.some(seg => seg === "phren" || seg.startsWith("phren@"))) return true;
  // Also match commands that include hook subcommands (used when installed via absolute path)
  const HOOK_MARKERS = ["hook-prompt", "hook-stop", "hook-session-start", "hook-tool"];
  if (HOOK_MARKERS.some(m => command.includes(m))) return true;
  return false;
}
/**
 * Reconcile the set of pre-prompt custom hook commands in `customHooks` with
 * sibling `UserPromptSubmit` entries in Claude Code's settings.json hooks map.
 *
 * Why: phren's chained `runPrePromptHooks` runs custom hooks sequentially
 * inside its own UserPromptSubmit handler, so a slow custom hook (e.g. one
 * that does an `ls` against a OneDrive-backed WSL mount) eats phren's whole
 * response budget and times out before injecting anything. Registering each
 * pre-prompt custom hook as a peer `UserPromptSubmit` entry lets Claude Code
 * dispatch it in parallel with phren's own hook — they get independent
 * timeout budgets and one cannot block the other.
 *
 * Identification: phren tracks "managed" sibling commands in
 * `prefs.managedPrePromptSiblingCommands`. On each sync we (a) append a new
 * sibling for each pre-prompt command not already in settings.json, (b)
 * remove sibling entries whose command was previously managed but is no
 * longer in `customHooks`, and (c) leave any user-authored hook entries
 * (entries whose command never appeared in the managed list) untouched.
 *
 * Webhook custom hooks are not affected — they're already async/fire-and-
 * forget and don't compete for hook event time.
 *
 * Idempotent.
 */
export function upsertCustomPrePromptSiblings(hooksMap: HookMap, phrenPath: string): { added: number; removed: number } {
  const customHooks = readCustomHooks(phrenPath);
  const desired: Array<{ command: string; timeoutSec: number }> = [];
  for (const h of customHooks) {
    if (h.event !== "pre-prompt") continue;
    if (!("command" in h)) continue;
    const cmd = h.command.trim();
    if (!cmd) continue;
    const timeoutSec = h.timeout != null ? Math.max(1, Math.ceil(h.timeout / 1000)) : 15;
    desired.push({ command: cmd, timeoutSec });
  }
  const desiredCommands = new Set(desired.map((d) => d.command));

  const prefs = readInstallPreferences(phrenPath);
  const previouslyManaged = new Set(Array.isArray(prefs.managedPrePromptSiblingCommands) ? prefs.managedPrePromptSiblingCommands : []);

  if (!Array.isArray(hooksMap.UserPromptSubmit)) hooksMap.UserPromptSubmit = [];
  const eventHooks = hooksMap.UserPromptSubmit as HookEntry[];

  // Remove stale siblings: previously managed but no longer desired
  let removed = 0;
  for (let i = eventHooks.length - 1; i >= 0; i--) {
    const entry = eventHooks[i];
    const inner = entry?.hooks;
    if (!Array.isArray(inner) || inner.length !== 1) continue;
    const cmd = typeof inner[0]?.command === "string" ? inner[0].command : "";
    if (!cmd) continue;
    if (previouslyManaged.has(cmd) && !desiredCommands.has(cmd)) {
      eventHooks.splice(i, 1);
      removed++;
    }
  }

  // Compute set of commands currently present in settings.json (any entry)
  const presentCommands = new Set<string>();
  for (const entry of eventHooks) {
    const inner = entry?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (typeof h?.command === "string") presentCommands.add(h.command);
    }
  }

  // Append new siblings for each desired command not already present
  let added = 0;
  for (const d of desired) {
    if (presentCommands.has(d.command)) continue;
    eventHooks.push({
      matcher: "",
      hooks: [{ type: "command", command: d.command, timeout: d.timeoutSec }],
    });
    added++;
  }

  // Update bookkeeping: managed = current desired set
  const newManaged = Array.from(desiredCommands).sort();
  const oldManaged = Array.from(previouslyManaged).sort();
  if (newManaged.length !== oldManaged.length || newManaged.some((c, i) => c !== oldManaged[i])) {
    updateInstallPreferences(phrenPath, () => ({ managedPrePromptSiblingCommands: newManaged }));
  }

  return { added, removed };
}

export function configureClaude(phrenPath: string, opts: { mcpEnabled?: boolean; hooksEnabled?: boolean } = {}): McpConfigStatus {
  const settingsPath = hookConfigPath("claude");
  const claudeJsonPath = homePath(".claude.json");
  const entryScript = resolveEntryScript();
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(phrenPath);
  const hooksEnabled = opts.hooksEnabled ?? getHooksEnabledPreference(phrenPath);
  const lifecycle = buildLifecycleCommands(phrenPath);
  let status: McpConfigStatus = "already_disabled";

  if (fs.existsSync(claudeJsonPath)) {
    patchJsonFile(claudeJsonPath, (data) => {
      status = upsertMcpServer(data, mcpEnabled, "mcpServers", phrenPath);
    });
  }

  patchJsonFile(settingsPath, (data) => {
    const settingsStatus = upsertMcpServer(data, mcpEnabled, "mcpServers", phrenPath);
    if (status === "already_disabled") status = settingsStatus;

    const hooksMap = isRecord(data.hooks) ? data.hooks as HookMap : (data.hooks = {} as HookMap);

    const upsertPhrenHook = (eventName: "UserPromptSubmit" | "Stop" | "SessionStart" | "PostToolUse", hookBody: { type: string; command: string; timeout?: number }) => {
      if (!Array.isArray(hooksMap[eventName])) hooksMap[eventName] = [];
      const eventHooks = hooksMap[eventName] as HookEntry[];
      const marker = eventName === "UserPromptSubmit" ? "hook-prompt"
        : eventName === "Stop" ? "hook-stop"
        : eventName === "PostToolUse" ? "hook-tool"
        : "hook-session-start";
      // Find the HookEntry containing a phren hook command
      const existingEntryIdx = eventHooks.findIndex(
        (h: HookEntry) => h?.hooks?.some(
          (hook) =>
            typeof hook?.command === "string" &&
            (
              hook.command.includes(marker) ||
              isPhrenCommand(hook.command)
            )
        )
      );
      if (existingEntryIdx >= 0) {
        // Only rewrite the matching inner hook item; preserve sibling non-phren hooks
        const entry = eventHooks[existingEntryIdx];
        const innerIdx = (entry.hooks ?? []).findIndex(
          (hook) =>
            typeof hook?.command === "string" &&
            (
              hook.command.includes(marker) ||
              isPhrenCommand(hook.command)
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

    const toolHookEnabled = hooksEnabled && isFeatureEnabled("PHREN_FEATURE_TOOL_HOOK", true);

    if (hooksEnabled) {
      upsertPhrenHook("UserPromptSubmit", {
        type: "command",
        command: lifecycle.userPromptSubmit || `node "${entryScript}" hook-prompt`,
        timeout: 3,
      });

      // Mirror pre-prompt custom hooks into Claude's settings.json as
      // peer UserPromptSubmit entries so they run in parallel with phren
      // and don't share its 3-second timeout budget. See
      // upsertCustomPrePromptSiblings docstring for details.
      try {
        upsertCustomPrePromptSiblings(hooksMap, phrenPath);
      } catch (err: unknown) {
        // Sync is best-effort: a malformed prefs file should not break
        // the rest of configureClaude. Surface a warning and continue.
        console.warn(`configureClaude: pre-prompt sibling sync failed: ${errorMessage(err)}`);
      }

      upsertPhrenHook("Stop", {
        type: "command",
        command: lifecycle.stop,
      });

      upsertPhrenHook("SessionStart", {
        type: "command",
        command: lifecycle.sessionStart,
      });

      if (toolHookEnabled) {
        upsertPhrenHook("PostToolUse", {
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
            (hook) => typeof hook.command === "string" && isPhrenCommand(hook.command)
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

export function configureVSCode(
  phrenPath: string,
  opts: { mcpEnabled?: boolean; scope?: "user" | "workspace" } = {}
): McpConfigStatus | "no_vscode" {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(phrenPath);
  if (opts.scope === "workspace") {
    const manifest = readRootManifest(phrenPath);
    if (manifest?.installMode !== "project-local" || !manifest.workspaceRoot) return "no_vscode";
    const mcpFile = path.join(manifest.workspaceRoot, ".vscode", "mcp.json");
    return configureMcpAtPath(mcpFile, mcpEnabled, "servers", "${workspaceFolder}/.phren");
  }
  const probe = probeVSCodePath();
  if (!probe.installed || !probe.targetDir) return "no_vscode";
  const mcpFile = path.join(probe.targetDir, "mcp.json");
  return configureMcpAtPath(mcpFile, mcpEnabled, "servers", phrenPath);
}

export function configureCursorMcp(phrenPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(phrenPath);
  const resolved = resolveCursorMcpConfig(commandExists);
  if (!resolved.installed) return "no_cursor";
  return configureMcpAtPath(resolved.target, mcpEnabled, "mcpServers", phrenPath);
}

export function configureCopilotMcp(phrenPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(phrenPath);
  const resolved = resolveCopilotMcpConfig(commandExists);
  if (!resolved.installed) return "no_copilot";
  let status: McpConfigStatus = "already_disabled";
  if (resolved.hasCliDir) {
    status = configureMcpAtPath(resolved.cliConfig, mcpEnabled, "mcpServers", phrenPath);
  }
  if (resolved.existing && resolved.existing !== resolved.cliConfig) {
    status = configureMcpAtPath(resolved.existing, mcpEnabled, "mcpServers", phrenPath);
  }
  if (!resolved.hasCliDir && !resolved.existing) {
    status = configureMcpAtPath(resolved.cliConfig, mcpEnabled, "mcpServers", phrenPath);
  }
  return status;
}

export function configureCodexMcp(phrenPath: string, opts: { mcpEnabled?: boolean } = {}): ToolStatus {
  const mcpEnabled = opts.mcpEnabled ?? getMcpEnabledPreference(phrenPath);
  const resolved = resolveCodexMcpConfig(phrenPath, commandExists);
  if (!resolved.installed) return "no_codex";

  if (resolved.preferToml) {
    return patchTomlMcpServer(resolved.tomlPath, mcpEnabled, phrenPath);
  }
  return configureMcpAtPath(resolved.existingJson!, mcpEnabled, "mcpServers", phrenPath);
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
