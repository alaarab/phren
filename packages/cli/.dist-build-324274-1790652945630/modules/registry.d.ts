import type { ModuleManifest, ModulesConfig } from "./manifest.js";
export declare const BUILTIN_MODULES: readonly ModuleManifest[];
export declare function readConfig(store: string): ModulesConfig | undefined;
/**
 * Unknown keys belong to a newer CLI that enabled a module this build (the
 * Hook) does not know; they are ignored, kept for writes, and warned about
 * once instead of failing every Hook connection.
 */
export declare function validateConfig(input: unknown, warnUnknown?: boolean): ModulesConfig;
/** Reads never mutate configuration or enable dependencies implicitly. */
export declare function enabled(store: string, profile?: string): readonly ModuleManifest[];
export declare function resolveModules(config: ModulesConfig | undefined, profile?: string): readonly ModuleManifest[];
export declare function moduleSource(config: ModulesConfig | undefined, name: string, profile?: string): "default" | "store" | "profile";
export declare function toolOwner(name: string): ModuleManifest | undefined;
export declare function commandOwner(command: string): ModuleManifest | undefined;
export declare function disabledHint(name: string): string;
