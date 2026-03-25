/**
 * Hooks mode toggle: enables/disables phren lifecycle hooks for Claude and other tools.
 */
import { debugLog, findPhrenPath, readRootManifest } from "../shared.js";
import { errorMessage } from "../utils.js";
import { configureAllHooks } from "../hooks.js";
import { configureClaude } from "./config.js";
import type { ToolStatus } from "./config.js";
import {
  getMcpEnabledPreference,
  getHooksEnabledPreference,
  setHooksEnabledPreference,
} from "./preferences.js";
import { DEFAULT_PHREN_PATH, log, parseMcpMode } from "./shared.js";

export async function runHooksMode(modeArg?: string) {
  const phrenPath = findPhrenPath() || (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  const manifest = readRootManifest(phrenPath);
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getHooksEnabledPreference(phrenPath);
    log(`Hooks mode: ${current ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: phren hooks-mode on|off`);
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
