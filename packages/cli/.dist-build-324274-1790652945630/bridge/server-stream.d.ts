import { WebSocket } from "ws";
import type { AgentHooks } from "./agent-hooks.js";
import { type Provider, type Target } from "./protocol.js";
import type { CodexQuestions } from "./questions.js";
import type { HookInfo } from "./server-routes.js";
import type { SideQuestions } from "./side-questions.js";
import { TranscriptReader } from "./transcripts.js";
import type { ModuleSnapshot } from "../modules/runtime.js";
import { type SettingsSwitcher } from "./settings-switch.js";
/** The WebSocket transcript and status streams: the backlog, appended rows and
 * previews on a tick loop, older pages on request, and the pane's status. */
export interface StreamContext {
    modules: ModuleSnapshot;
    agentHooks: AgentHooks;
    codexQuestions: CodexQuestions;
    sideQuestions?: SideQuestions;
    settingsSwitcher?: SettingsSwitcher;
    info: HookInfo;
    activeCapabilities: Record<string, unknown>;
}
export type TranscriptStreams = ReturnType<typeof transcriptStreams>;
/**
 * Why a transcript or status stream closed. Only a real target change (the
 * 409 validation) says the conversation changed; I/O, parse and git failures
 * keep their own words, with absolute paths cut to their last component and
 * the reason bounded to WebSocket's 123-byte close limit.
 */
export declare function streamCloseReason(error: unknown): string;
export declare function transcriptStreams(ctx: StreamContext): {
    conversationReader: (target: Target) => Promise<{
        reader?: TranscriptReader;
        source: Provider;
        session: string;
    }>;
    childConversationReader: (target: Target, child: string) => Promise<{
        reader: TranscriptReader;
        source: "claude" | "codex" | "copilot" | "opencode" | "phren";
        session: string;
    }>;
    emptyPage: {
        entries: never[];
        totalLines: number;
        startLine: number;
        hasMore: boolean;
        reset: boolean;
    };
    stream: (client: WebSocket, url: URL) => Promise<void>;
};
