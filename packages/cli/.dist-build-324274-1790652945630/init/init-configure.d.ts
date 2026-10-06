import { repairPreexistingInstall } from "./setup.js";
import { type ManagementCapabilities, type ManagementPreset } from "./management-preset.js";
import type { InitOptions } from "./init.js";
/**
 * Configure MCP for all detected AI coding tools (Claude, VS Code, Cursor, Copilot, Codex).
 * @param verb - label used in log messages, e.g. "Updated" or "Configured"
 */
export declare function configureMcpTargets(phrenPath: string, opts: {
    mcpEnabled: boolean;
    hooksEnabled: boolean;
    caps?: ManagementCapabilities;
}, verb?: "Configured" | "Updated"): string;
/**
 * Configure hooks if enabled, or log a disabled message.
 * @param verb - label used in log messages, e.g. "Updated" or "Configured"
 */
export declare function configureHooksIfEnabled(phrenPath: string, hooksEnabled: boolean, verb: string, caps?: ManagementCapabilities): void;
export declare function applyOnboardingPreferences(phrenPath: string, opts: InitOptions): void;
export declare function writeWalkthroughEnvDefaults(phrenPath: string, opts: InitOptions, presetContext?: {
    preset: ManagementPreset;
    explicit: boolean;
}): string[];
export declare function collectRepairedAssetLabels(repaired: ReturnType<typeof repairPreexistingInstall>): string[];
export declare function applyProjectStorageBindings(repoRoot: string, phrenPath: string): string[];
export declare function warmSemanticSearch(phrenPath: string, profile?: string): Promise<string>;
export declare function runProjectLocalInit(opts?: InitOptions): Promise<void>;
