import { type FanoutManifest } from "../bridge/fanouts.js";
import { type LaunchOptions, type Provider } from "./adapters/types.js";
export declare const adapters: {
    codex: import("./adapters/types.js").Adapter;
    opencode: import("./adapters/types.js").Adapter;
    claude: import("./adapters/types.js").Adapter;
};
export interface JobOptions extends Omit<LaunchOptions, "job"> {
    store: string;
    provider: Provider;
    label: string;
    reason: string;
    prompt: string;
}
export declare function jobsRoot(store: string): string;
export declare function readJob(store: string, id: string): FanoutManifest;
export declare function listJobs(store: string): FanoutManifest[];
export declare function swiftBuildCount(): number;
/** The nearest codex or claude process above this one. Each agent sets its
 * own id for the commands it runs and inherits the other's, so a Claude
 * started from Codex has both; the process tree says which one launched. */
export declare function nearestAgent(pid?: number): "codex" | "claude" | undefined;
export declare function writeManifest(job: string, manifest: FanoutManifest): void;
export declare function createJob(options: JobOptions, env?: NodeJS.ProcessEnv, nearest?: typeof nearestAgent): {
    job: string;
    manifest: FanoutManifest;
};
export declare function launch(options: JobOptions, reservation?: {
    job: string;
    manifest: FanoutManifest;
}): Promise<number>;
