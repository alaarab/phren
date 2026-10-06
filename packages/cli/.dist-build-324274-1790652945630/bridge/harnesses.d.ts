import { type AccountRef, type AuthRunner } from "./claude-accounts.js";
import { type ToolVersion } from "./health.js";
export type HarnessSource = "claude" | "codex" | "opencode" | "copilot";
export interface HarnessAccount extends AccountRef {
    signedIn: boolean;
    usable: boolean;
    plan?: string;
    reason?: string;
}
export interface HarnessEntry {
    source: HarnessSource;
    installed: boolean;
    version?: string;
    usable: boolean;
    reason?: string;
    accounts?: HarnessAccount[];
}
export interface HarnessInventory {
    harnesses: HarnessEntry[];
}
export interface HarnessDeps {
    toolVersion?: (tool: string) => Promise<ToolVersion>;
    authRunner?: AuthRunner;
    env?: NodeJS.ProcessEnv;
}
export declare function harnessInventory(deps?: HarnessDeps): Promise<HarnessInventory>;
/** The inventory, or undefined when it is not ready within `ms` (a cold `claude auth status` can take seconds). */
export declare function harnessInventoryWithin(ms: number, deps?: HarnessDeps): Promise<HarnessInventory | undefined>;
/** `PHREN_LAUNCH_CHECK=off`: no early launch refusal and no `harnesses` advertised to dispatch (tests, or a misreporting computer). */
export declare function launchCheckOff(env?: NodeJS.ProcessEnv): boolean;
export type Availability = {
    ok: true;
} | {
    ok: false;
    code: "harness_unavailable" | "account_unavailable";
    reason: string;
};
/** Whether a launch of `source` (and `accountId`) should work on a computer with this inventory. */
export declare function hasUsable(inventory: HarnessInventory, source: string, accountId?: string): Availability;
