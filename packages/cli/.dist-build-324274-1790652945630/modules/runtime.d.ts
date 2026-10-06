import type { ModuleManifest } from "./manifest.js";
export interface ModuleSnapshot {
    store: string;
    profile: string;
    modules: readonly ModuleManifest[];
    generation: string;
    has(name: string): boolean;
}
export declare function moduleSnapshot(store: string, profile?: string, legacyHook?: boolean): ModuleSnapshot;
export declare function moduleEnabled(store: string, name: string, profile?: string): boolean;
export declare function requireModule(store: string, name: string, profile?: string): void;
export declare function migrateInstalledModules(store: string, legacyHook?: boolean): void;
/** The version in <bridge>/installed.json, or undefined when no Hook is installed. */
export declare function installedHookVersion(): string | undefined;
export declare function activateModules(store: string, profile?: string, legacyHook?: boolean): ModuleSnapshot;
