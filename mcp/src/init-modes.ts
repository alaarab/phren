/**
 * MCP-mode and hooks-mode toggle commands.
 */
import {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
} from "./config.js";
import type { ToolStatus } from "./config.js";
import type { McpMode } from "./init-walkthrough.js";
import { configureAllHooks } from "./hooks.js";
import {
  debugLog,
  findPhrenPath,
  readRootManifest,
} from "./shared.js";
import { errorMessage } from "./utils.js";
import {
  getMcpEnabledPreference,
  getHooksEnabledPreference,
  setMcpEnabledPreference,
  setHooksEnabledPreference,
} from "./preferences.js";
import { DEFAULT_PHREN_PATH, log } from "./shared.js";

export function parseMcpMode(raw?: string): McpMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "off") return normalized;
  return undefined;
}

export async function runMcpMode(modeArg?: string) {
  const phrenPath = findPhrenPath() || (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  const manifest = readRootManifest(phrenPath);
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getMcpEnabledPreference(phrenPath);
    const hooks = getHooksEnabledPreference(phrenPath);
    log(`MCP mode: ${current ? "on (recommended)" : "off (hooks-only fallback)"}`);
    log(`Hooks mode: ${hooks ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx phren mcp-mode on|off`);
    log(`Hooks toggle: npx phren hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }
  const enabled = mode === "on";

  if (manifest?.installMode === "project-local") {
    const vscodeStatus = configureVSCode(phrenPath, { mcpEnabled: enabled, scope: "workspace" });
    setMcpEnabledPreference(phrenPath, enabled);
    log(`MCP mode set to ${mode}.`);
    log(`VS Code status: ${vscodeStatus}`);
    log(`Project-local mode only configures workspace VS Code MCP.`);
    return;
  }

  let claudeStatus: ToolStatus = "no_settings";
  let vscodeStatus: ToolStatus = "no_vscode";
  let cursorStatus: ToolStatus = "no_cursor";
  let copilotStatus: ToolStatus = "no_copilot";
  let codexStatus: ToolStatus = "no_codex";
  try { claudeStatus = configureClaude(phrenPath, { mcpEnabled: enabled }) ?? claudeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureClaude failed: ${errorMessage(err)}`); }
  try { vscodeStatus = configureVSCode(phrenPath, { mcpEnabled: enabled }) ?? vscodeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureVSCode failed: ${errorMessage(err)}`); }
  try { cursorStatus = configureCursorMcp(phrenPath, { mcpEnabled: enabled }) ?? cursorStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCursorMcp failed: ${errorMessage(err)}`); }
  try { copilotStatus = configureCopilotMcp(phrenPath, { mcpEnabled: enabled }) ?? copilotStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCopilotMcp failed: ${errorMessage(err)}`); }
  try { codexStatus = configureCodexMcp(phrenPath, { mcpEnabled: enabled }) ?? codexStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCodexMcp failed: ${errorMessage(err)}`); }

  // Persist preference only after config writes have been attempted
  setMcpEnabledPreference(phrenPath, enabled);

  log(`MCP mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`VS Code status: ${vscodeStatus}`);
  log(`Cursor status: ${cursorStatus}`);
  log(`Copilot CLI status: ${copilotStatus}`);
  log(`Codex status: ${codexStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runHooksMode(modeArg?: string) {
  const phrenPath = findPhrenPath() || (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  const manifest = readRootManifest(phrenPath);
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getHooksEnabledPreference(phrenPath);
    log(`Hooks mode: ${current ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx phren hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }

  if (manifest?.installMode === "project-local") {
    throw new Error("hooks-mode is unsupported in project-local mode");
  }

  const enabled = mode === "on";

  let claudeStatus: ToolStatus = "no_settings";
  try {
    claudeStatus = configureClaude(phrenPath, {
      mcpEnabled: getMcpEnabledPreference(phrenPath),
      hooksEnabled: enabled,
    }) ?? claudeStatus;
  } catch (err: unknown) { debugLog(`hooks-mode: configureClaude failed: ${errorMessage(err)}`); }

  if (enabled) {
    try {
      const hooked = configureAllHooks(phrenPath, { allTools: true });
      if (hooked.length) log(`Updated hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`hooks-mode: configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log("Hooks will no-op immediately via preference and Claude hooks are removed.");
  }

  // Persist preference only after config writes have been attempted
  setHooksEnabledPreference(phrenPath, enabled);

  log(`Hooks mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`Restart your agent to apply changes.`);
}
