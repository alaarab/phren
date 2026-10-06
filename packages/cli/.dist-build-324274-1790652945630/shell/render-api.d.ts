/**
 * Read-only rendering API for the shell views, consumable by external packages
 * via the "@phren/cli/shell/render-api" subpath export.
 *
 * Exposes renderMenuFrame (render a full shell view frame) and handleMenuKey
 * (pure navigation logic) without pulling in mutation or MCP dependencies.
 */
import type { ShellState } from "./state-store.js";
export type MenuView = ShellState["view"];
export interface MenuState {
    view: MenuView;
    project?: string;
    filter?: string;
    cursor: number;
    scroll: number;
}
export interface MenuRenderResult {
    /** Full ANSI-rendered frame (multi-line string, no trailing newline) */
    output: string;
    /** Number of list items in the current view (for cursor clamping) */
    listCount: number;
}
/** Render a full shell frame for the given state. Read-only, no mutations. */
export declare function renderMenuFrame(phrenPath: string, profile: string, state: MenuState): Promise<MenuRenderResult>;
/**
 * Apply a key to the menu state. Returns a new state, or null to signal
 * "exit menu mode" (Tab or Escape at top level).
 */
export declare function handleMenuKey(state: MenuState, keyName: string, listCount: number, phrenPath?: string, profile?: string): MenuState | null;
