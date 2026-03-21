/**
 * MCP target configuration for all detected AI coding tools.
 */
import {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
} from "./init-config.js";
import { debugLog } from "./shared.js";
import { errorMessage } from "./utils.js";
import { log } from "./init-shared.js";

/**
 * Configure MCP for all detected AI coding tools (Claude, VS Code, Cursor, Copilot, Codex).
 * @param verb - label used in log messages, e.g. "Updated" or "Configured"
 */
export function configureMcpTargets(
  phrenPath: string,
  opts: { mcpEnabled: boolean; hooksEnabled: boolean },
  verb: "Configured" | "Updated" = "Configured",
): string {
  let claudeStatus = "no_settings";
  try {
    const status = configureClaude(phrenPath, { mcpEnabled: opts.mcpEnabled, hooksEnabled: opts.hooksEnabled });
    claudeStatus = status ?? "installed";
    if (status === "disabled" || status === "already_disabled") {
      log(`  ${verb} Claude Code hooks (MCP disabled)`);
    } else {
      log(`  ${verb} Claude Code MCP + hooks`);
    }
  } catch (e) {
    log(`  Could not configure Claude Code settings (${e}), add manually`);
  }

  let vsStatus = "no_vscode";
  try {
    vsStatus = configureVSCode(phrenPath, { mcpEnabled: opts.mcpEnabled }) ?? "no_vscode";
    logMcpTargetStatus("VS Code", vsStatus, verb);
  } catch (err: unknown) {
    debugLog(`configureVSCode failed: ${errorMessage(err)}`);
  }

  let cursorStatus = "no_cursor";
  try {
    cursorStatus = configureCursorMcp(phrenPath, { mcpEnabled: opts.mcpEnabled }) ?? "no_cursor";
    logMcpTargetStatus("Cursor", cursorStatus, verb);
  } catch (err: unknown) {
    debugLog(`configureCursorMcp failed: ${errorMessage(err)}`);
  }

  let copilotStatus = "no_copilot";
  try {
    copilotStatus = configureCopilotMcp(phrenPath, { mcpEnabled: opts.mcpEnabled }) ?? "no_copilot";
    logMcpTargetStatus("Copilot CLI", copilotStatus, verb);
  } catch (err: unknown) {
    debugLog(`configureCopilotMcp failed: ${errorMessage(err)}`);
  }

  let codexStatus = "no_codex";
  try {
    codexStatus = configureCodexMcp(phrenPath, { mcpEnabled: opts.mcpEnabled }) ?? "no_codex";
    logMcpTargetStatus("Codex", codexStatus, verb);
  } catch (err: unknown) {
    debugLog(`configureCodexMcp failed: ${errorMessage(err)}`);
  }

  const allStatuses = [claudeStatus, vsStatus, cursorStatus, copilotStatus, codexStatus];
  if (allStatuses.some((s) => s === "installed" || s === "already_configured")) return "installed";
  if (allStatuses.some((s) => s === "disabled" || s === "already_disabled")) return "disabled";
  return claudeStatus;
}
