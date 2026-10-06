import type { ServerResponse } from "node:http";
import type { AgentHooks } from "./agent-hooks.js";
import { type WorktreeWorker } from "./git-worktrees.js";
import { type ModelSwitcher } from "./model-switch.js";
import type { SettingsSwitcher } from "./settings-switch.js";
import { type Json, type Target } from "./protocol.js";
import type { CodexQuestions } from "./questions.js";
import { type SideQuestions } from "./side-questions.js";
/** Routes that act on one pane's conversation: prompts, answer keys, typed
 * secrets, uploads, diffs, git, approvals and questions. A starting pane (no
 * conversation yet) takes keys, a secret or a first prompt. */
export interface PaneRouteContext {
    agentHooks: AgentHooks;
    modelSwitcher: ModelSwitcher;
    settingsSwitcher: SettingsSwitcher;
    codexQuestions: CodexQuestions;
    sideQuestions: SideQuestions;
}
export declare function uploadBody(data: Json): {
    name: string;
    bytes: Buffer;
};
/** The repository a git route acts on: the pane's trusted directory, a
 * spawned child's own worktree exactly as /v1/diff resolves it, or one of the
 * pane repository's other worktrees as `/v1/git/worktrees` lists it. */
export declare function gitRepository(pane: Json, target: Target, child: unknown, worktree?: unknown): Promise<string>;
/** Agents running in this Herdr server's panes, by the folder each works in:
 * an agent launched into a new worktree from the phone is named here. Listed
 * last, so a sub-agent or fan-out manifest for the same folder wins a tie. */
export declare function herdrWorktreeWorkers(s: Json): WorktreeWorker[];
/** A busy Claude Code queues typed text on Enter, but after a long paste
 * ("paste again to expand") it can swallow that Enter and leave the text in
 * its input line, where it stays after the turn ends. Follow the pane: once
 * it has stayed finished for two looks while the prompt is still unsubmitted,
 * press Enter once. A closed or replaced pane, a delivery the conversation
 * took, or ten minutes end the watch; a pane asking for input is never answered. */
export declare function followQueuedDelivery(agentHooks: AgentHooks, target: Target, terminal: unknown, text: string, intervalMs?: number): void;
export declare function paneRoute(ctx: PaneRouteContext, url: URL, data: Json, response: ServerResponse): Promise<unknown>;
