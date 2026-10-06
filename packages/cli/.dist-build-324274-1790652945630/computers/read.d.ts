import type { ComputerResources } from "../bridge/resources.js";
import type { AccountUsage, UsageWindow } from "../bridge/usage.js";
import type { Json } from "../bridge/protocol.js";
/**
 * The memory-free computers surface: every read goes to the local Hook's
 * socket (`GET /v1/resources?peers=1`, `GET /v1/usage?peers=1`), which answers
 * for itself and asks each linked computer over its pinned SSH pipe. Nothing
 * here opens, needs or reports a Phren store, findings or tasks, and nothing
 * writes: `phren computers`, `phren usage` and `phren computers mcp` share it.
 */
export interface ComputerReport {
    name: string;
    /** This computer, the one whose Hook answered. */
    local: boolean;
    online: boolean;
    resources?: ComputerResources;
    error?: string;
}
/** Every harness the Hook reads usage for, in the order people look for them. */
export declare const USAGE_SOURCES: readonly ["claude", "codex", "copilot", "opencode", "opencode-go", "openrouter"];
export declare const HARNESS_NAMES: Record<string, string>;
export interface HarnessUsage {
    source: string;
    harness: string;
    windows: Array<UsageWindow & {
        resetsIn?: string;
    }>;
    spend?: AccountUsage["spend"];
    updatedAt?: string;
    /** What the harness said, or why it gave nothing. Never a guess. */
    message?: string;
}
export interface UsageReport {
    computers: Array<{
        name: string;
        local: boolean;
        harnesses?: HarnessUsage[];
        error?: string;
    }>;
    /** Across computers: account limits from the freshest report, local spend summed. */
    combined: HarnessUsage[];
}
type Request = (route: string) => Promise<Json>;
export declare function readComputers(options?: {
    peers?: boolean;
    request?: Request;
    localFallback?: () => Promise<ComputerResources>;
}): Promise<{
    computers: ComputerReport[];
    hookError?: string;
    peerError?: string;
}>;
export declare function findComputer(computers: ComputerReport[], name: string | undefined): ComputerReport | undefined;
export type PlatformChoice = "mac" | "linux" | "any";
/**
 * The least-loaded online computer: stressed ones last, then by overall
 * pressure, then load per core, then free disk. Each candidate carries why.
 */
export declare function pickComputer(computers: ComputerReport[], platform?: PlatformChoice, exclude?: string[]): {
    pick?: ComputerReport;
    reason: string;
    ranked: Array<{
        name: string;
        score: number;
        level: string;
        why: string;
    }>;
};
export declare function describe(r: ComputerResources): string;
export declare function resetsIn(resetsAt: string | undefined, now?: number): string | undefined;
/**
 * Account limits are the same account seen from each computer, so the
 * freshest report with windows stands. OpenCode's cost ledger is per
 * computer, so its spend adds up; OpenRouter's is one key, reported once.
 */
export declare function combineUsage(perComputer: HarnessUsage[][]): HarnessUsage[];
export declare function readUsage(options?: {
    peers?: boolean;
    request?: Request;
    now?: number;
}): Promise<UsageReport & {
    hookError?: string;
    peerError?: string;
}>;
export {};
