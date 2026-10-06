import { type ModuleSnapshot } from "../modules/runtime.js";
export declare const forcedCommand = "command=\"sh ~/.local/share/phren/bridge/dispatch\"";
export declare function upgradeKeys(text: string): {
    text: string;
    changed: number;
};
/** The existing LaunchAgent's own EnvironmentVariables beyond phren's, read
 * with plutil. A missing or unreadable plist has none. */
export declare function extraLaunchAgentEnvironment(file: string, read?: (file: string) => Promise<string>): Promise<Record<string, string>>;
export interface LaunchAgentValues {
    label: string;
    node: string;
    program: string;
    path: string;
    root: string;
    herdr: string;
    store: string;
    profile: string;
}
/** The Hook's LaunchAgent: phren's own environment first, then every kept key. */
export declare function launchAgentXml(values: LaunchAgentValues, extra?: Record<string, string>): string;
/** The forwarder the forced command uses for the phone's byte pipe. */
export type GatewayKind = "socat" | "nc" | "node";
export interface GatewayEnvironment {
    root: string;
    herdr: string;
    store: string;
    profile: string;
    node: string;
    bundle: string;
    socket: string;
    timing: string;
}
/** Pick the cheapest reliable forwarder at install time: socat, then an nc that
 *  understands Unix sockets, then the node gateway that always works. */
export declare function detectGateway(env?: NodeJS.ProcessEnv): Promise<GatewayKind>;
/** The POSIX sh forced command: the phone's byte pipe goes straight to the Hook
 *  socket through a tiny forwarder, so a loaded machine never pays for a fresh
 *  node process; every other SSH command falls through to the node gateway. */
export declare function gatewayScript(gateway: GatewayKind, environment: GatewayEnvironment): string;
/** The commands that restart the Hook in `domain`, printed when launchd refuses. */
export declare function launchCommands(domain: string, plist: string): string[];
export declare function install(version: string, noService?: boolean): Promise<void>;
export declare function uninstall(): Promise<void>;
interface SettingsEdit {
    file: string;
    before?: string;
    after: string;
}
export declare function planAgentHooks(program: string, remove?: boolean, modules?: ModuleSnapshot, fastClaude?: boolean): Promise<SettingsEdit[]>;
/** The first line of every plugin copy phren wrote; a copy without it belongs to the user. */
export declare const OPENCODE_PLUGIN_MARKER = "// Installed by Phren Hook";
/** Whether to (re)write the installed plugin: a missing copy, or one phren wrote that is now out of date. */
export declare function opencodePluginNeedsWrite(existing: string | undefined, source: string): boolean;
export declare function rollback(): Promise<void>;
export declare function reconcileModuleHooks(store: string, profile?: string): Promise<void>;
export {};
