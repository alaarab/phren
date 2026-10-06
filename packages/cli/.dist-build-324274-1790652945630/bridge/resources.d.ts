/**
 * This computer's live resources for `GET /v1/resources`, the overview
 * stream's `resources` frames and the memory-free `phren computers` surface:
 * load against cores, memory, free disk on the home volume, battery, uptime
 * and the heavy jobs (simulators, emulators, xcodebuild, Gradle, agent
 * workers) with the pane that started them where one did; any other program
 * holding half a core or more across its processes shows as `busy`. macOS reads
 * sysctl, pmset and ps; Linux reads /proc, /sys and ps. Nothing here needs a
 * permission the Hook does not already have.
 */
export declare const RESOURCES_MAX_AGE_MS: number;
/** Below this much free disk, or above twice the cores in load, a computer is stressed. */
export declare const LOW_DISK_BYTES: number;
export type HeavyKind = "simulator" | "emulator" | "xcodebuild" | "gradle" | "java" | "codex" | "opencode" | "claude" | "busy";
export interface PaneRef {
    server: string;
    workspace?: string;
    pane: string;
    agent?: string;
    label?: string;
}
export interface HeavyProcess {
    kind: HeavyKind;
    name: string;
    pid: number;
    /** OS processes, including helpers; never a count of agents or working sessions. */
    processes: number;
    cpuPercent: number;
    memoryBytes: number;
    /** Why this process group is listed; resource use does not establish session activity. */
    resourceReason?: "cpu" | "memory" | "tracked";
    pane?: PaneRef;
}
export interface ComputerResources {
    collectedAt: string;
    platform: string;
    uptimeSeconds: number;
    cpu: {
        cores: number;
        load1: number;
        load5: number;
        load15: number;
        loadPerCore: number;
    };
    memory: {
        totalBytes: number;
        availablePercent?: number;
        pressure?: "normal" | "warn" | "critical";
        swapUsedBytes?: number;
    };
    disk?: {
        path: string;
        totalBytes: number;
        freeBytes: number;
    };
    battery?: {
        percent: number;
        charging: boolean;
        onAC: boolean;
    };
    heavy: HeavyProcess[];
    /** 0 idle to 1 saturated, per resource and overall (the highest), so every client fills its gauge the same way. */
    pressure: {
        cpu: number;
        memory: number;
        disk: number;
        overall: number;
    };
    level: "ok" | "busy" | "stressed";
    warnings: Array<"load-high" | "memory-low" | "disk-low" | "battery-low">;
}
export interface ProcessRow {
    pid: number;
    ppid: number;
    cpu: number;
    rssKB: number;
    command: string;
    args: string;
}
/** `ps -axo pid=,ppid=,pcpu=,rss=,comm=` paired with the `args=` listing by pid. */
export declare function parsePs(stats: string, args: string): ProcessRow[];
/** What kind of heavy job a process is, if any. */
export declare function heavyKind(row: ProcessRow): {
    kind: HeavyKind;
    name: string;
} | undefined;
/**
 * The heavy jobs in a process table. Every process counts toward its nearest
 * heavy ancestor-or-self, so a Codex worker running xcodebuild shows both,
 * each with only its own share. Any other program shows as `busy` when its
 * processes together hold half a core. Known programs below both a core's
 * tenth and 200 MiB are left out, including simulators and emulators.
 * A memory-only row can be an idle session or helper; it is not evidence of
 * agent activity. Counts include OS helpers, not just the named executable.
 * On Linux, ps pcpu is a process lifetime average, so these cutoffs can miss
 * daemons that spike briefly.
 */
export declare function heavyProcesses(rows: ProcessRow[], owners?: Map<number, PaneRef>, limit?: number): HeavyProcess[];
/** `pmset -g batt`: "Now drawing from 'AC Power'" then " -InternalBattery-0 (id=…)	87%; charging; …". */
export declare function parsePmset(output: string): ComputerResources["battery"];
/** `sysctl vm.swapusage`: "total = 2048.00M  used = 798.50M  free = …". */
export declare function parseSwap(output: string): number | undefined;
/** /proc/meminfo: MemTotal, MemAvailable and swap, in kB. */
export declare function parseMeminfo(text: string): ComputerResources["memory"];
/** Gauge fill and warnings from the numbers. */
export declare function assess(value: Omit<ComputerResources, "pressure" | "level" | "warnings">): Pick<ComputerResources, "pressure" | "level" | "warnings">;
/** Every pid a Herdr or tmux pane holds (its shell and foreground), for naming a job's pane. */
export declare function paneOwners(): Promise<Map<number, PaneRef>>;
export interface ResourceDeps {
    platform: NodeJS.Platform;
    now: () => number;
    home: () => string;
    processes: () => Promise<ProcessRow[]>;
    owners: () => Promise<Map<number, PaneRef>>;
}
export declare function collectResources(deps: ResourceDeps): Promise<ComputerResources>;
/** One collection at a time, reused for `RESOURCES_MAX_AGE_MS`. */
export declare class ResourceMonitor {
    private maxAgeMs;
    private cached?;
    private pending?;
    private readonly deps;
    constructor(deps?: Partial<ResourceDeps>, maxAgeMs?: number);
    read(): Promise<ComputerResources>;
}
