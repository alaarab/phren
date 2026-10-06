/**
 * MCP mode toggle: enables/disables phren as an MCP server across all detected tools.
 */
import { debugLog, findPhrenPath, readRootManifest } from "../shared.js";
import { errorMessage } from "../utils.js";
import { configureClaude, configureVSCode, configureCursorMcp, configureCopilotMcp, configureCodexMcp, } from "./config.js";
import { getMcpEnabledPreference, getHooksEnabledPreference, setMcpEnabledPreference, } from "./preferences.js";
import { DEFAULT_PHREN_PATH, log, parseMcpMode } from "./shared.js";
export async function runMcpMode(modeArg) {
    const phrenPath = findPhrenPath() || (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
    const manifest = readRootManifest(phrenPath);
    const normalizedArg = modeArg?.trim().toLowerCase();
    if (!normalizedArg || normalizedArg === "status") {
        const current = getMcpEnabledPreference(phrenPath);
        const hooks = getHooksEnabledPreference(phrenPath);
        log(`MCP mode: ${current ? "on (recommended)" : "off (hooks-only fallback)"}`);
        log(`Hooks mode: ${hooks ? "on (active)" : "off (disabled)"}`);
        log(`Change mode: phren mcp-mode on|off`);
        log(`Hooks toggle: phren hooks-mode on|off`);
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
    let claudeStatus = "no_settings";
    let vscodeStatus = "no_vscode";
    let cursorStatus = "no_cursor";
    let copilotStatus = "no_copilot";
    let codexStatus = "no_codex";
    try {
        claudeStatus = configureClaude(phrenPath, { mcpEnabled: enabled }) ?? claudeStatus;
    }
    catch (err) {
        debugLog(`mcp-mode: configureClaude failed: ${errorMessage(err)}`);
    }
    try {
        vscodeStatus = configureVSCode(phrenPath, { mcpEnabled: enabled }) ?? vscodeStatus;
    }
    catch (err) {
        debugLog(`mcp-mode: configureVSCode failed: ${errorMessage(err)}`);
    }
    try {
        cursorStatus = configureCursorMcp(phrenPath, { mcpEnabled: enabled }) ?? cursorStatus;
    }
    catch (err) {
        debugLog(`mcp-mode: configureCursorMcp failed: ${errorMessage(err)}`);
    }
    try {
        copilotStatus = configureCopilotMcp(phrenPath, { mcpEnabled: enabled }) ?? copilotStatus;
    }
    catch (err) {
        debugLog(`mcp-mode: configureCopilotMcp failed: ${errorMessage(err)}`);
    }
    try {
        codexStatus = configureCodexMcp(phrenPath, { mcpEnabled: enabled }) ?? codexStatus;
    }
    catch (err) {
        debugLog(`mcp-mode: configureCodexMcp failed: ${errorMessage(err)}`);
    }
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
