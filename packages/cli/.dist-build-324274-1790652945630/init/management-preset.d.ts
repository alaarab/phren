export type ManagementPreset = "managed" | "assisted" | "manual";
export declare const MANAGEMENT_PRESETS: readonly ManagementPreset[];
export declare const DEFAULT_MANAGEMENT_PRESET: ManagementPreset;
/** Structural + behavioral capabilities a preset expands into. */
export interface ManagementCapabilities {
    /** Symlink global/AGENTS.md into ~/.claude/CLAUDE.md (+ copilot instructions). */
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
/** Parse a user-supplied preset name; undefined for invalid/empty input. */
export declare function parseManagementPreset(value?: string | null): ManagementPreset | undefined;
/** The capability bundle for a preset (no per-user overrides applied). */
export declare function presetCapabilities(preset: ManagementPreset): ManagementCapabilities;
/** Current preset from install preferences; absent → managed. */
export declare function getManagementPreset(phrenPath: string): ManagementPreset;
/**
 * Capabilities for a given preset overlaid with any explicit per-capability
 * booleans already present in install-preferences.json. Use this when applying
 * a preset (e.g. during init) that may not yet be persisted, so the caller can
 * pass the intended preset while still honoring existing power-user overrides.
 */
export declare function capabilitiesForPreset(phrenPath: string, preset: ManagementPreset): ManagementCapabilities;
/**
 * Resolve effective capabilities: the persisted preset bundle overlaid with
 * any explicit per-capability booleans set in install-preferences.json.
 */
export declare function resolveManagementCapabilities(phrenPath: string): ManagementCapabilities;
/** One-line human descriptions per preset, reused by the walkthrough + status. */
export declare function presetSummaryLines(preset: ManagementPreset): string;
