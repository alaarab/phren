import type { IncomingMessage, ServerResponse } from "node:http";
import type { FanoutMessages } from "./fanout-messages.js";
import type { ModuleSnapshot } from "../modules/runtime.js";
import type { ActivityJournal } from "./activity.js";
import type { AgentHooks } from "./agent-hooks.js";
import type { WorkspaceContextUsage } from "./context.js";
import { type DispatchService } from "./dispatch.js";
import { type DispatchReturns } from "./dispatch-returns.js";
import type { LaunchLimiter } from "./limits.js";
import { type Json } from "./protocol.js";
import type { CodexQuestions } from "./questions.js";
import type { TabActivityStore } from "./tab-activity.js";
import type { ModelCatalog } from "./models.js";
import type { ModelSwitcher } from "./model-switch.js";
import type { SettingsSwitcher } from "./settings-switch.js";
import type { SideQuestions } from "./side-questions.js";
import { type AccountUsageReader } from "./usage.js";
import type { ResourceMonitor } from "./resources.js";
import type { Scheduler } from "./schedules.js";
import type { TranscriptStreams } from "./server-stream.js";
/** The Hook's HTTP API over its Unix socket: module gating, the GET routes,
 * the POST routes that are not bound to one pane, and grant deletion. */
/** What /v1/health reports about this computer and its Hook. */
export interface HookInfo {
    product: string;
    protocol: number;
    version: string;
    computer: {
        id: string;
        name: string;
        aliases?: string[];
    };
    capabilities: Record<string, unknown>;
    modules: Record<string, string>;
    store: string;
    profile: string;
    generation: string;
    readonly load: {
        average: number;
        cpus: number;
    };
    readonly gatewayMs: number | undefined;
}
export interface RouteContext {
    version: string;
    modules: ModuleSnapshot;
    info: HookInfo;
    computerID: string;
    scheduleStore: string;
    scheduler?: Scheduler;
    dispatches?: DispatchService;
    returns?: DispatchReturns;
    agentHooks: AgentHooks;
    journal: ActivityJournal;
    tabActivity: TabActivityStore;
    contextUsage: WorkspaceContextUsage;
    modelCatalog: ModelCatalog;
    modelSwitcher: ModelSwitcher;
    settingsSwitcher: SettingsSwitcher;
    sideQuestions: SideQuestions;
    accountUsage: AccountUsageReader;
    resources: ResourceMonitor;
    codexQuestions: CodexQuestions;
    launches: LaunchLimiter;
    locatedDirectories: Set<string>;
    fanoutMessages: FanoutMessages;
    canary: (trigger: "manual" | "daily") => Promise<unknown>;
    streams: TranscriptStreams;
}
/** How long the overview waits for per-tab git and transcript reads; the phone gives up at 20 s. */
export declare const OVERVIEW_ENRICH_BUDGET_MS = 5000;
export declare const capabilities: {
    transcript: boolean;
    progress: boolean;
    images: boolean;
    prompt: boolean;
    stop: boolean;
    terminal: string;
    shell: string;
    herdr: boolean;
    diff: boolean;
    webServers: boolean;
    webPreview: string;
    activity: boolean;
    approvals: boolean;
    questions: boolean;
    accountUsage: boolean;
    providers: string[];
    files: boolean;
    repositoryFiles: boolean;
    subagents: boolean;
    sideQuestions: boolean;
    dispatch: boolean;
    approvalPush: string;
    simulators: boolean;
    code: boolean;
    overviewStream: boolean;
    speech: boolean;
    speechTimestamps: boolean;
    speechVoices: boolean;
    speechFormats: ("mp3_44100_192" | "pcm_24000" | "pcm_44100")[];
    transcribe: boolean;
    memoryStore: boolean;
    promptOnce: boolean;
    resources: boolean;
};
export declare function capabilitiesForModules(snapshot: ModuleSnapshot): Record<string, unknown>;
export declare function requireRoute(snapshot: ModuleSnapshot, method: string, route: string): void;
export declare function selectedServer(url: URL): string;
/**
 * The overview a phone draws for one Herdr server: every tab with its agent,
 * target, branch, model, running children and current step, from one
 * `session.snapshot`. `GET /v1/workspaces` passes a fresh snapshot; the
 * `/v1/overview` stream passes the shared one it already holds.
 */
export type WorkspacesReader = (server: string, s: Json, watchApprovals: boolean) => Promise<Json>;
export declare function workspacesReader(ctx: Pick<RouteContext, "modules" | "info" | "agentHooks" | "journal" | "tabActivity" | "contextUsage">): WorkspacesReader;
export declare function createRouteHandler(ctx: RouteContext): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
