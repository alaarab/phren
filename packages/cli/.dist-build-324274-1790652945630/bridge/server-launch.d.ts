import { type HarnessInventory } from "./harnesses.js";
import { type Json } from "./protocol.js";
/** The live conductor on this computer, on any Herdr server, as a target.
 * `known` reuses a snapshot the caller already took. */
export declare function localConductor(known?: {
    server: string;
    snapshot: Json;
}): Promise<{
    server: string;
    target?: Json;
} | undefined>;
/** The Herdr agent-name slug for a human label: "Conductor smoke 4" becomes "conductor-smoke-4". */
export declare function herdrAgentName(label: string): string;
type InventoryReader = () => Promise<HarnessInventory>;
/** Only for tests: what this computer can launch. Without one, `PHREN_LAUNCH_CHECK=off` skips the early availability check. */
export declare function setLaunchInventory(reader: InventoryReader | undefined): void;
export interface LaunchOptions {
    canary?: boolean;
    /** `data.cwd` is a folder the Hook resolved itself (a dispatched or
     * scheduled project's source folder), so it may be marked trusted for the
     * harness before the launch. Never set for a folder the phone chose. */
    trustFolder?: boolean;
}
/**
 * "Open on a computer": a new Herdr workspace (or a tab in an existing one)
 * in the project's directory, with the chosen agent started in its pane.
 * Herdr's create calls do not return identifiers, so the new tab is found
 * by diffing snapshots; `agent.start` returns once Herdr has detected the
 * agent and it is ready for input, which can take most of `timeoutMs`.
 */
export declare function launchSession(server: string, data: Json, options?: LaunchOptions): Promise<Json>;
export declare function workspaceAction(server: string, operation: string, data: Json): Promise<Json>;
export {};
