/**
 * Management presets: how much of the user's machine phren wires up.
 *
 * Phren's flagship experience actively manages symlinks, skills, hooks and
 * lifecycle automations. Not everyone wants that. A named preset lets a user
 * dial the footprint down without hunting through scattered env flags:
 *
 *   - managed  (default): the historical behavior — MCP + hooks + home
 *              symlinks (~/.claude/CLAUDE.md, ~/.claude/skills), CLI/session
 *              wrappers, repo mirroring (still ownership-gated), lifecycle
 *              automations, and SessionStart self-heal of the above.
 *   - assisted: MCP + hooks (context injection, capture, store git sync) but
 *              phren writes NOTHING outside its own store and agent settings —
 *              no CLAUDE.md symlink, no skills symlinks, no ~/.local/bin
 *              wrappers, no self-heal. Project ownership defaults to detached.
 *              Init prints a self-wiring snippet so users wire their own files.
 *   - manual:   MCP server registration only. No hooks, no automations, no
 *              daily maintenance, no auto commit/push. A pull-based knowledge
 *              base the agent must choose to call.
 *
 * Presets are thin bundles over mostly-existing toggles. Individual capability
 * overrides in install-preferences.json win over the preset bundle, so a power
 * user can, e.g., run "assisted" but re-enable selfHeal. Precedence, strongest
 * first:
 *   1. PHREN_FEATURE_* env / ~/.phren/.env flags (runtime, for the automations
 *      they already gate — this module does not duplicate them).
 *   2. Explicit per-capability boolean in install-preferences.json.
 *   3. Preset bundle default (this file).
 *   4. Built-in managed defaults (preset absent).
 */
import { readInstallPreferences } from "./preferences.js";

export type ManagementPreset = "managed" | "assisted" | "manual";

export const MANAGEMENT_PRESETS: readonly ManagementPreset[] = ["managed", "assisted", "manual"] as const;

export const DEFAULT_MANAGEMENT_PRESET: ManagementPreset = "managed";

/** Structural + behavioral capabilities a preset expands into. */
export interface ManagementCapabilities {
  /** Symlink global/CLAUDE.md into ~/.claude/CLAUDE.md (+ copilot instructions). */
  linkGlobalClaudeMd: boolean;
  /** Symlink managed skills into ~/.claude/skills (+ other agent skill dirs). */
  installSkillLinks: boolean;
  /** Install ~/.local/bin/{phren,copilot,cursor,codex} wrappers. */
  installWrappers: boolean;
  /** Re-create home symlinks/skills every SessionStart. */
  selfHeal: boolean;
  /** Mirror phren docs/skills into phren-managed project repos (still ownership-gated). */
  repoMirroring: boolean;
  /** Daily maintenance + Stop auto-commit/push of the store. */
  lifecycleAutomations: boolean;
  /** Whether lifecycle hooks are installed/active by default under this preset. */
  hooksDefault: boolean;
  /** Whether fresh-install project ownership is forced to "detached". */
  ownershipForcedDetached: boolean;
}

const PRESET_CAPABILITIES: Record<ManagementPreset, ManagementCapabilities> = {
  managed: {
    linkGlobalClaudeMd: true,
    installSkillLinks: true,
    installWrappers: true,
    selfHeal: true,
    repoMirroring: true,
    lifecycleAutomations: true,
    hooksDefault: true,
    ownershipForcedDetached: false,
  },
  assisted: {
    linkGlobalClaudeMd: false,
    installSkillLinks: false,
    installWrappers: false,
    selfHeal: false,
    repoMirroring: false,
    lifecycleAutomations: true,
    hooksDefault: true,
    ownershipForcedDetached: true,
  },
  manual: {
    linkGlobalClaudeMd: false,
    installSkillLinks: false,
    installWrappers: false,
    selfHeal: false,
    repoMirroring: false,
    lifecycleAutomations: false,
    hooksDefault: false,
    ownershipForcedDetached: true,
  },
};

/** Parse a user-supplied preset name; undefined for invalid/empty input. */
export function parseManagementPreset(value?: string | null): ManagementPreset | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return (MANAGEMENT_PRESETS as readonly string[]).includes(normalized)
    ? (normalized as ManagementPreset)
    : undefined;
}

/** The capability bundle for a preset (no per-user overrides applied). */
export function presetCapabilities(preset: ManagementPreset): ManagementCapabilities {
  return { ...PRESET_CAPABILITIES[preset] };
}

/** Current preset from install preferences; absent → managed. */
export function getManagementPreset(phrenPath: string): ManagementPreset {
  const prefs = readInstallPreferences(phrenPath);
  return prefs.managementPreset ?? DEFAULT_MANAGEMENT_PRESET;
}

/**
 * Capabilities for a given preset overlaid with any explicit per-capability
 * booleans already present in install-preferences.json. Use this when applying
 * a preset (e.g. during init) that may not yet be persisted, so the caller can
 * pass the intended preset while still honoring existing power-user overrides.
 */
export function capabilitiesForPreset(phrenPath: string, preset: ManagementPreset): ManagementCapabilities {
  const prefs = readInstallPreferences(phrenPath);
  const base = presetCapabilities(preset);
  const overlay = <K extends keyof ManagementCapabilities>(key: K, value: boolean | undefined): boolean =>
    value === undefined ? base[key] : value;
  return {
    linkGlobalClaudeMd: overlay("linkGlobalClaudeMd", prefs.linkGlobalClaudeMd),
    installSkillLinks: overlay("installSkillLinks", prefs.installSkillLinks),
    installWrappers: overlay("installWrappers", prefs.installWrappers),
    selfHeal: overlay("selfHeal", prefs.selfHeal),
    repoMirroring: overlay("repoMirroring", prefs.repoMirroring),
    lifecycleAutomations: overlay("lifecycleAutomations", prefs.lifecycleAutomations),
    hooksDefault: base.hooksDefault,
    ownershipForcedDetached: base.ownershipForcedDetached,
  };
}

/**
 * Resolve effective capabilities: the persisted preset bundle overlaid with
 * any explicit per-capability booleans set in install-preferences.json.
 */
export function resolveManagementCapabilities(phrenPath: string): ManagementCapabilities {
  return capabilitiesForPreset(phrenPath, getManagementPreset(phrenPath));
}

/** One-line human descriptions per preset, reused by the walkthrough + status. */
export function presetSummaryLines(preset: ManagementPreset): string {
  switch (preset) {
    case "managed":
      return "phren wires everything: MCP, hooks, ~/.claude symlinks, skills, self-heal (recommended)";
    case "assisted":
      return "MCP + hooks only — phren never writes outside its store; you wire CLAUDE.md/skills yourself";
    case "manual":
      return "MCP server only — pull-based knowledge base, no hooks or automations";
  }
}
