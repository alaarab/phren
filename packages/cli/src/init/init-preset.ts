/**
 * `phren preset [status|managed|assisted|manual]` — switch the management preset.
 *
 * Switching re-wires MCP/hooks for the new preset and, on a downgrade, tears down
 * the phren-owned symlinks/wrappers/repo-mirrors the previous preset installed;
 * on an upgrade it re-creates them. MCP registration stays on across all presets.
 */
import { debugLog, findPhrenPath, readRootManifest } from "../shared.js";
import { errorMessage } from "../utils.js";
import { configureClaude } from "./config.js";
import { configureMcpTargets, configureHooksIfEnabled } from "./init-configure.js";
import { repairPreexistingInstall } from "./setup.js";
import {
  getMcpEnabledPreference,
  getHooksEnabledPreference,
  setHooksEnabledPreference,
  setManagementPresetPreference,
} from "./preferences.js";
import {
  MANAGEMENT_PRESETS,
  getManagementPreset,
  parseManagementPreset,
  presetSummaryLines,
  resolveManagementCapabilities,
  type ManagementCapabilities,
} from "./management-preset.js";
import { removePhrenHomeSymlinks, removePhrenWrappers, sweepAgentSkillSymlinks, sweepProjectMirrors } from "./teardown.js";
import { printSelfWiringSnippet } from "./self-wiring.js";
import { DEFAULT_PHREN_PATH, log, confirmPrompt } from "./shared.js";

function printCapabilityTable(caps: ManagementCapabilities): void {
  const row = (label: string, on: boolean) => log(`    ${on ? "on " : "off"}  ${label}`);
  row("MCP server registration", true);
  row("Lifecycle hooks", caps.hooksDefault);
  row("~/.claude/CLAUDE.md symlink", caps.linkGlobalClaudeMd);
  row("~/.claude/skills symlinks", caps.installSkillLinks);
  row("~/.local/bin wrappers", caps.installWrappers);
  row("SessionStart self-heal", caps.selfHeal);
  row("Repo mirroring", caps.repoMirroring);
  row("Lifecycle automations (maintenance, auto-commit)", caps.lifecycleAutomations);
}

export async function runPreset(arg?: string, opts: { yes?: boolean } = {}): Promise<void> {
  const phrenPath = findPhrenPath() || process.env.PHREN_PATH || DEFAULT_PHREN_PATH;
  const manifest = readRootManifest(phrenPath);
  const normalized = arg?.trim().toLowerCase();

  if (!normalized || normalized === "status") {
    const current = getManagementPreset(phrenPath);
    log(`Management preset: ${current} — ${presetSummaryLines(current)}`);
    printCapabilityTable(resolveManagementCapabilities(phrenPath));
    log(`Change: phren preset <${MANAGEMENT_PRESETS.join("|")}>`);
    return;
  }

  const preset = parseManagementPreset(normalized);
  if (!preset) {
    throw new Error(`Invalid preset "${arg}". Use one of: ${MANAGEMENT_PRESETS.join(", ")}`);
  }

  if (manifest?.installMode === "project-local") {
    throw new Error("preset switching is unsupported in project-local mode");
  }

  const previous = getManagementPreset(phrenPath);
  const prevCaps = resolveManagementCapabilities(phrenPath);
  if (preset === previous) {
    log(`Already on the ${preset} preset.`);
    printCapabilityTable(prevCaps);
    return;
  }

  // Persist first so caps resolution (incl. the self-heal path) sees the new preset.
  setManagementPresetPreference(phrenPath, preset);
  const caps = resolveManagementCapabilities(phrenPath);

  const teardownNeeded =
    (prevCaps.linkGlobalClaudeMd && !caps.linkGlobalClaudeMd) ||
    (prevCaps.installSkillLinks && !caps.installSkillLinks) ||
    (prevCaps.installWrappers && !caps.installWrappers) ||
    (prevCaps.repoMirroring && !caps.repoMirroring);

  if (teardownNeeded && !opts.yes) {
    const ok = await confirmPrompt(
      `Switching ${previous} → ${preset} will remove phren-owned symlinks/wrappers from your machine and repos. Continue?`
    );
    if (!ok) {
      // Revert the preference — the user declined the teardown.
      setManagementPresetPreference(phrenPath, previous);
      log("Aborted. Preset unchanged.");
      return;
    }
  }

  log(`Switching management preset: ${previous} → ${preset}\n`);

  // Hooks follow the preset default (manual disables them).
  const mcpEnabled = getMcpEnabledPreference(phrenPath);
  const hooksEnabled = caps.hooksDefault && (previous === "manual" ? true : getHooksEnabledPreference(phrenPath));
  setHooksEnabledPreference(phrenPath, hooksEnabled);

  try {
    configureClaude(phrenPath, { mcpEnabled, hooksEnabled });
  } catch (err: unknown) {
    debugLog(`preset: configureClaude failed: ${errorMessage(err)}`);
  }
  try {
    configureMcpTargets(phrenPath, { mcpEnabled, hooksEnabled, caps }, "Updated");
  } catch (err: unknown) {
    debugLog(`preset: configureMcpTargets failed: ${errorMessage(err)}`);
  }
  configureHooksIfEnabled(phrenPath, hooksEnabled, "Updated", caps);

  // Teardown of artifacts the previous preset installed but the new one doesn't.
  if (prevCaps.linkGlobalClaudeMd && !caps.linkGlobalClaudeMd) removePhrenHomeSymlinks();
  if (prevCaps.installSkillLinks && !caps.installSkillLinks) sweepAgentSkillSymlinks(phrenPath);
  if (prevCaps.installWrappers && !caps.installWrappers) removePhrenWrappers();
  if (prevCaps.repoMirroring && !caps.repoMirroring) sweepProjectMirrors(phrenPath);

  // Setup of artifacts the new preset adds but the previous one lacked.
  const setupNeeded =
    (!prevCaps.linkGlobalClaudeMd && caps.linkGlobalClaudeMd) ||
    (!prevCaps.installSkillLinks && caps.installSkillLinks) ||
    (!prevCaps.repoMirroring && caps.repoMirroring);
  if (setupNeeded) {
    try {
      repairPreexistingInstall(phrenPath, { caps, preset });
    } catch (err: unknown) {
      debugLog(`preset: repair failed: ${errorMessage(err)}`);
    }
    try {
      const { runLink } = await import("../link/link.js");
      await runLink(phrenPath, {});
    } catch (err: unknown) {
      debugLog(`preset: runLink failed: ${errorMessage(err)}`);
    }
  }

  log(`\nManagement preset set to ${preset}.`);
  printCapabilityTable(caps);
  if (preset !== "managed") {
    printSelfWiringSnippet(phrenPath, preset);
  }
  log(`\nRestart your agent to apply changes.`);
}
