import { AgentHooks } from "./agent-hooks.js";
import { type Json, type Target } from "./protocol.js";
/** The phone's permission modes, in T3's words. */
export declare const PERMISSION_MODES: readonly ["supervised", "auto-edits", "auto", "full-access"];
export interface SettingsCapabilities {
    permissionModes: string[];
    plan: boolean;
    fast: boolean;
}
/** What this pane can change from the phone; undefined for harnesses that
 * offer nothing. A hand-started Codex TUI is empty: its state is still read
 * from its transcript, but switching is not offered. Claude's cycle holds
 * `full-access` only when it was launched allowing bypass. */
export declare function settingsCapabilities(source: string, codexServed: boolean, claudeBypass?: boolean): SettingsCapabilities | undefined;
/** Claude's permission mode from the footer line its TUI draws under the
 * composer. The transcript lags it: a `permission-mode` row is written only
 * when a prompt is submitted, and a fresh session has no file yet. The line may
 * trail hints ("(shift+tab to cycle) · 1 agent"), so only its start counts. */
export declare function claudeFooterMode(screen: string): string | undefined;
export interface SettingsState {
    permissionMode?: string;
    plan?: boolean;
    fast?: boolean;
}
/** A Claude pane's settings as its footer shows them, read at most once per
 * `PHREN_DIALOG_THROTTLE_MS` like the dialog check, and whether bypass was
 * ever seen in it (which is when full access is offered). */
export declare class ClaudeSettingsReader {
    private readonly hooks;
    private readonly every;
    private cache;
    constructor(hooks: AgentHooks, every?: number);
    read(target: Target, terminal: unknown): Promise<{
        state?: SettingsState;
        bypass: boolean;
    }>;
}
/** One settings transaction per pane owns its terminal input until it ends. */
export declare class SettingsSwitcher {
    private readonly hooks;
    private readonly wait;
    private active;
    private readonly reader;
    constructor(hooks: AgentHooks, wait?: number);
    /** A Claude pane's footer-read settings and capabilities for the stream. */
    streamSettings(target: Target, terminal: unknown, codexServed: boolean): Promise<{
        settings?: SettingsCapabilities;
        settingsState?: SettingsState;
    }>;
    private key;
    assertAvailable(target: Target): void;
    switch(target: Target, data: Json): Promise<Json>;
    private hold;
    private claude;
}
