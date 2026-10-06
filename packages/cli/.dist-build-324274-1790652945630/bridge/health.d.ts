import { type TmuxHealth } from "./terminal-tmux.js";
/** One tool's installed version, or why there is none. */
export interface ToolVersion {
    tool: string;
    status: "ok" | "missing" | "error";
    version?: string;
    detail?: string;
}
export interface StoreSync {
    name: string;
    role: string;
    available: boolean;
    branch?: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
    lastPushStatus?: string;
    lastPushAt?: string;
    lastSuccessfulPushAt?: string;
    consecutiveFailures?: number;
    /** The last sync failure in plain words, only while the store is failing. */
    error?: string;
    degraded: boolean;
}
export interface LastScheduledRun {
    name?: string;
    project: string;
    status: string;
    reason?: string;
    startedAt: string;
    finishedAt?: string;
}
export interface PeerHealth {
    name: string;
    reachable: boolean;
    ms: number;
    error?: string;
    version?: string;
    /** Why an unreachable peer failed, as a stable offline code (docs/phren-hook.md#offline-reasons). */
    code?: string;
    /** Whether the peer's own hooks.yaml lists this computer; null when its Hook is too old to say. */
    listsBack: boolean | null;
}
export interface CanaryStep {
    name: string;
    status: "ok" | "failed" | "skipped";
    durationMs: number;
    reason?: string;
    detail?: string;
}
export interface CanaryResult {
    version: 1;
    trigger: "manual" | "daily";
    computer: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    ok: boolean;
    steps: CanaryStep[];
}
export interface HealthDetails {
    product: "phren-hook";
    computer: {
        name: string;
        id?: string;
    };
    checkedAt: string;
    versions: ToolVersion[];
    stores: StoreSync[];
    schedules: {
        running: boolean | null;
        lastTickAt?: string;
        lastRun: LastScheduledRun | null;
    };
    peers: {
        configured: boolean;
        error?: string;
        computers: PeerHealth[];
    };
    push: {
        configured: boolean;
        devices?: number;
    };
    canary: CanaryResult | null;
    terminal: TerminalHealth;
}
/** Which terminal multiplexer the Hook drives, per running server, and tmux's state. */
export interface TerminalHealth {
    /** "herdr" while a Herdr server answers, else "tmux" when tmux can host agents, else "none". */
    provider: "herdr" | "tmux" | "none";
    servers: {
        name: string;
        provider: "herdr" | "tmux";
    }[];
    tmux: TmuxHealth;
}
/** The running servers the Hook lists (Herdr's, else tmux's) and tmux's own state. */
export declare function terminalHealth(): Promise<TerminalHealth>;
/** One line on the terminal: the provider, its servers and tmux's state. */
export declare function describeTerminal(terminal: TerminalHealth): string;
export interface HealthOptions {
    /** The running Hook's own version; undefined when asked from outside a Hook. */
    hookVersion?: string;
    computerId?: string;
    store: string;
    /** The Hook knows whether its scheduler runs; a CLI caller does not. */
    scheduler?: {
        running: boolean;
        lastTickAt?: Date;
    };
    /** The Hook's loaded APNs sender; a CLI caller checks for apns.json instead. */
    push?: {
        configured: boolean;
        devices: number;
    };
}
/** `<tool> --version`, bounded to 3 seconds and remembered for 5 minutes. */
export declare function toolVersion(tool: string, executable?: string): Promise<ToolVersion>;
/** Only for tests: forget cached versions. */
export declare function clearVersionCache(): void;
/** Branch and ahead/behind against the upstream as last fetched; nothing is fetched here. */
export declare function storeSync(store: string): Promise<StoreSync[]>;
/** The newest run in schedule-runs.jsonl, with its schedule's name when the project still has it. */
export declare function lastScheduledRun(store: string, runsFile?: string): Promise<LastScheduledRun | null>;
/** Whether this computer's hooks.yaml lists the caller, by pinned host key or by name. */
export declare function listsCaller(caller: {
    name?: string;
    hostKey?: string;
}): Promise<{
    computers: string[];
    knowsCaller: boolean;
}>;
export declare function canaryFile(root?: string): string;
export declare function readCanary(root?: string): Promise<CanaryResult | null>;
/** Everything a person needs to tell whether phren is healthy on this computer.
 * Bounded: versions are cached, each peer probe stops at 5 seconds, and nothing
 * here returns a secret, a file's contents or a store path. */
export declare function healthDetails(options: HealthOptions): Promise<HealthDetails>;
/** Plain lines for `phren status`. */
export declare function formatHealth(health: HealthDetails, color: {
    dim: string;
    reset: string;
    red: string;
    yellow: string;
    green: string;
}): string[];
