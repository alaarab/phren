import { type ModuleSnapshot } from "../modules/runtime.js";
import { type Json, type Provider, type Target } from "./protocol.js";
import { ToolChanges } from "./changes.js";
import { ApprovalPushService } from "./push.js";
import { type RequestKind } from "./approval-summary.js";
import { type DialogAnswer, type DialogQuestion } from "./claude-question-dialog.js";
import { type TerminalChoice } from "./terminal-choice.js";
import { ApprovalWatchLeases } from "./agent-hook-stores.js";
import type { AppServerRequestId, PendingServerRequest } from "./codex-app-server.js";
import { PaneServerWatcher, type PaneAsks } from "./opencode-panes.js";
import type { PaneClient, PaneServerEntry } from "./opencode-pane-server.js";
export { permissionPrompt, terminalChoice, visibleTerminalChoice, type TerminalChoice, type TerminalQuestion } from "./terminal-choice.js";
export { ApprovalWatchLeases, PushBindingStore, recordedSession } from "./agent-hook-stores.js";
/** Where a held request's answer goes: the callback's HTTP response, or the
 * reply to a Codex app-server request (codex-servers.ts). Either takes the
 * PermissionRequest-shaped JSON; "{}" gives the request back to the terminal. */
interface HeldReply {
    end(body: string): unknown;
    readonly destroyed: boolean;
}
interface Pending {
    target: Target;
    response: HeldReply;
    tool: string;
    input: unknown;
    message: string;
    request: string;
    requestKind: RequestKind;
    title?: string;
    choice?: TerminalChoice;
    expiresAt: string;
    timer?: NodeJS.Timeout;
    conductor?: {
        action: "dispatch" | "hand_off";
        project?: string;
        computer?: string;
    };
    /** A server request of the Hook's own Codex app-server: answered over RPC, never held on a timer. */
    appServer?: {
        requestId: AppServerRequestId;
        answer: (result: Json) => void;
    };
}
/** The approval card's tool and input for an app-server request, in the
 * shapes `approvalSummary` and the phone already read for Codex's hook.
 * Undefined for questions (`item/tool/requestUserInput`) and MCP
 * elicitations, which stay in the pane. */
export declare function appServerApproval(request: PendingServerRequest): {
    tool: string;
    input: Json;
} | undefined;
/** The app-server's answer for the phone's allow or deny (T3's
 * CodexSessionRuntime shapes: accept / decline, a permission grant or none). */
export declare function appServerDecision(request: PendingServerRequest, allow: boolean): Json;
/** A conductor `dispatch` or `hand_off` permission ask the Hook can answer
 * itself under a standing grant, or offer the phone two grant-writing answers. */
export declare function conductorCall(tool: string, input: unknown): Pending["conductor"] | undefined;
export type DeliveryOutcome = "delivered" | "blocked" | "pending";
/** This socket is deliberately separate from the phone's HTTP pipe. Only local
 * agent callbacks can register identities or create an approval request. */
export declare class AgentHooks {
    readonly push: ApprovalPushService;
    private modules?;
    readonly changes: ToolChanges;
    private pending;
    /** Prompts Phren has typed into a pane, by their text, until the agent that
     * actually receives one reports in through UserPromptSubmit. Herdr writes
     * to a pane, not a conversation; the receiving agent's hook is the only
     * party that knows which conversation consumed the text, so it is the one
     * that can refuse it when that is not the conversation the phone meant. */
    private deliveries;
    /** The permission request a conversation is drawing in its own terminal
     * because nobody was there to hold it: what the phone shows above its
     * answer keys until the pane stops waiting. `dialog` marks a choice parsed
     * from the pane's own numbered lines, whose answers gain an Enter, and
     * `questions` carries a released AskUserQuestion's normalized question set
     * with the index currently being answered. */
    private terminalPrompts;
    /** The last time each pane's terminal lines were read for a dialog, so a
     * status tick reads them at most once per three seconds per pane. */
    private dialogReads;
    /** Panes whose last read terminal line is a password prompt, so the status
     * frame can offer the phone's secret sheet only when one is really asking. */
    private passwords;
    /** Conversations Claude Code is compacting, by target, until the new context
     * starts. The phone shows the state instead of the summary row's text. */
    private compactingSince;
    /** Panes where Phren just typed a bare slash command: the agent is drawing
     * that command's menu, which Herdr reports as an idle agent, so keys are
     * allowed there for a short while to walk and confirm it. The command text
     * and a one-shot confirmation attempt ride with the window. */
    private menus;
    private watching;
    readonly overview: ApprovalWatchLeases;
    private server?;
    private pushBindings;
    /** Held asks that were pushed: action -> when the notification expires. */
    private pushedHolds;
    /** Pushed asks whose hold ended with the request left in the terminal. */
    private releasedHolds;
    /** Terminal dialogs pushed to phones: by pane, the dialog last pushed; by
     * action, what an answer from the notification types. */
    private dialogPushes;
    private dialogActions;
    /** opencode permission asks seen on disk or listed by a served pane, by request id. */
    private opencode;
    /** Questions served OpenCode panes are asking, by question id. */
    private servedQuestions;
    /** One event subscription per served OpenCode pane; ticked with the Hook. */
    readonly paneServers: PaneServerWatcher;
    private closed;
    private opencodeSweep?;
    private opencodeLive;
    private fanoutLive;
    private fanoutSweeping;
    private opencodeWatcher?;
    private opencodePoll?;
    private opencodeDebounce?;
    /** Fan-out jobs already pushed as blocked, by job id and blocked timestamp. */
    private fanoutSeen;
    private fanoutTimer?;
    private fanoutArchiveTimer?;
    /** The name the phone paired with (macOS Computer Name), for approval alerts;
     * the short host name until that lookup answers. */
    private computerName;
    constructor(push?: ApprovalPushService, modules?: ModuleSnapshot | undefined);
    private approvalsDirectory;
    private scheduleOpencodeSweep;
    /** Read every live opencode request file, map it to a target through the
     * recorded bindings or Herdr's explicit opencode session id, and register it
     * for a push and a push-binding answer. A file that vanished or expired is
     * forgotten. */
    sweepOpencodeApprovals(): Promise<void>;
    private readOpencodeApprovals;
    /** The pane a served OpenCode ask belongs to, as the phone names it: the
     * pane's place from its terminal, and the root of the asking session (a
     * subagent's ask shows on the conversation the pane shows). */
    private servedTarget;
    /** Everything a served pane is asking right now. New asks become the same
     * cards (and pushes) as the plugin's file asks; asks no longer listed were
     * answered in the TUI or went away, and their cards go with them. */
    servedAsks(entry: PaneServerEntry, client: PaneClient, asks: PaneAsks): Promise<void>;
    /** A served pane's process is gone: nothing it asked can be answered. */
    servedGone(key: string): void;
    /** The question a served OpenCode pane is asking, in the shape the phone
     * answers Claude's AskUserQuestion with (`/v1/questions/answer`). */
    servedQuestion(target: Target): Json | undefined;
    private servedClient;
    /** Answers a served pane's permission ask over its own API. */
    private answerServed;
    /** The phone's answers to a served pane's question: the labels it chose
     * (and a typed answer) per question, for exactly the questions it shows. */
    answerServedQuestion(target: Target, questions: DialogQuestion[], answers: DialogAnswer[]): Promise<void>;
    /** Keys the phone sends to a served OpenCode pane that its API answers
     * better than the terminal: Esc declines a pending question or stops a
     * working turn (`session.abort`), and a digit answers a pending
     * single-question, single-choice set. False leaves the keys to the pane. */
    servedKeys(target: Target, keys: readonly string[], status: string): Promise<boolean>;
    /** A session's exact pane. A recorded binding carries the full target; when
     * there is none, Herdr's explicit session identity names the pane. */
    private resolveTarget;
    /** Push once for each fan-out job whose blocked.json the plugin wrote. */
    private sweepBlockedFanouts;
    /** Move finished fan-out folders older than a day into the archive; one log
     * line records a sweep that moved or deleted anything, and a sweep that
     * fails never takes the Hook down. */
    private sweepFanoutArchive;
    watch(target: Target): () => void;
    /** Register a prompt about to be typed into `target`'s pane. The returned
     * promise settles "delivered" once that conversation's own hook submits the
     * text, "blocked" if another conversation in the pane tried to, or "pending"
     * after `waitMs`: a busy agent queues typed input and submits it only when
     * its turn ends, so the record outlives the wait (up to ten minutes) and a
     * late submission to the wrong conversation is still refused. */
    expectDelivery(target: Target, text: string, waitMs?: number, signal?: AbortSignal): Promise<DeliveryOutcome>;
    /** A prompt Phren typed into `target` that its conversation has not submitted yet. */
    deliveryPending(target: Target, text: string): boolean;
    /** Wait again for a delivery `expectDelivery` already reported pending,
     * after the Hook pressed Enter a second time. */
    awaitLateDelivery(target: Target, text: string, waitMs?: number): Promise<DeliveryOutcome>;
    /** The conversation `target` just submitted `prompt`. Nothing Phren typed
     * matches: a locally typed prompt, always allowed. Otherwise the oldest
     * matching delivery decides: its own conversation consumes it; any other
     * conversation is told to drop it, so the text is never spoken to the
     * wrong agent and the phone can safely send it again. */
    private submitted;
    /** The conversation's own turn events, for dispatch returns (turn-records.ts).
     * A failed write never fails the agent's callback. */
    private recordTurn;
    private rememberTerminalPrompt;
    /** The request the agent is showing in its terminal, if one fell through
     * in the last fifteen minutes; the caller only asks while the pane waits. */
    terminalPrompt(target: Target): Json | undefined;
    clearTerminalPrompt(target: Target): void;
    /** True while the pane's own terminal is reading a password. */
    passwordPrompt(target: Target): boolean;
    /** Claude Code's auto-mode fallback, opencode and Codex draw a numbered
     * dialog in the pane with no PermissionRequest hook behind it. While the pane
     * waits with nothing else to ask, read its last lines (at most once per
     * three seconds per pane) and publish the dialog as a terminal choice; drop
     * it when the pane leaves waiting or the dialog lines vanish. A remembered
     * permission request that is not a dialog keeps the slot untouched. The same
     * read notes whether the terminal is reading a password. */
    syncTerminalDialog(target: Target, active: boolean): Promise<void>;
    /** Resolve a phone option identifier. Real shortcuts retain their key path;
     * keyless rows are reached and verified before returning Enter to the route. */
    dialogAnswerKeys<K extends string>(target: Target, keys: readonly K[]): Promise<(K | "Enter")[]>;
    moveDialogHighlight(target: Target, expected: TerminalChoice, key: string, beforeKeys?: () => Promise<void>): Promise<void>;
    /** Put OpenCode's cursor on Allow once, the row's first option: ← as many
     * times as the cursor sits to its right, then read the colors again. The
     * same prompt must still be showing, or nothing more is sent. */
    private selectOpencodeOnce;
    /** Answer Claude's AskUserQuestion dialog in the pane: every question in
     * `answers` from `from` on, then the set's submission when `submit`. The
     * walk reads the pane before and after each key, so a dialog on another
     * tab, a changed question or a missed key stops it with nothing stray
     * typed. A finished set clears the remembered question. */
    answerClaudeQuestions(target: Target, questions: DialogQuestion[], answers: DialogAnswer[], options?: {
        from?: number;
        submit?: boolean;
    }): Promise<void>;
    /** An older phone answers a released AskUserQuestion one question at a
     * time with the chosen digits through `/v1/keys`. Walk that question with
     * the same verified steps and submit after the last. False when the
     * prompt is not a remembered question, so the keys take the usual path. */
    answerReleasedQuestion(target: Target, keys: readonly string[]): Promise<boolean>;
    private startCompacting;
    private stopCompacting;
    /** True while Claude Code is compacting `target`; a boundary older than ten
     * minutes is stale, so a missed SessionStart cannot pin the state forever. */
    compacting(target: Target): boolean;
    menuOpened(target: Target, command?: string): void;
    menuOpen(target: Target): boolean;
    /** The bare slash command that opened this pane's current menu window. */
    menuCommand(target: Target): string | undefined;
    menuClosed(target: Target): void;
    /** The pane with its colors, for dialogs whose cursor is only a color. */
    paneAnsi(target: Target): Promise<string>;
    /** Read what the pane draws, stripping ANSI unless placeholder styling is needed. */
    paneLines(target: Target, stripAnsi?: boolean): Promise<string>;
    /** After the phone walks Codex's /permissions menu onto Full Access, the
     * agent draws a second "Enable full access?" confirmation. Watch the pane's
     * terminal lines for it, answer with its own numbered choice, and only then
     * close the menu window. A confirmation that never arrives within three
     * seconds is left open as the visible prompt, published as the terminal
     * choice the phone draws as a question card. Runs at most once per window. */
    walkMenuConfirmation(target: Target): Promise<{
        menuClosed: boolean;
        waiting?: {
            message: string;
            choice?: TerminalChoice;
        };
    }>;
    approval(target: Target): Json | undefined;
    private opencodeApproval;
    /** Live fan-out worker asks shown on this parent conversation, oldest first. */
    private fanoutHeld;
    pendingPanes(server: string, state: Json): Set<string>;
    /** Hands the owner's answer to the fan-out launcher waiting on the worker's session. */
    private answerFanout;
    answer(target: Target, id: string, decision: unknown, updatedInput?: unknown): Promise<void>;
    /** A held approval that is really a terminal dialog, answered from the
     * phone with its own keys: let the callback fall back to the terminal at
     * once instead of leaving the card up until the 55-second timer. */
    releaseChoice(target: Target): void;
    /** The phone's Esc or Cancel on a question the Hook holds. A held
     * AskUserQuestion has no terminal choice, so `releaseChoice` never lets it
     * go and the terminal stays frozen until the hold timer; decline it now so
     * Claude moves on. True when a held question was cancelled. */
    cancelHeldQuestion(target: Target): boolean;
    answerPush(binding: string, decision: unknown): Promise<void>;
    /** Where a pushed ask lives, without answering it: the phone opens that
     * session's details when the notification itself is tapped. */
    pushTarget(binding: string): Target | undefined;
    /** Every waiting pane on this computer, each Hook tick, whether or not a
     * phone watches: an approval an agent draws as a numbered dialog in its
     * terminal (Claude's fallback prompts, Codex, OpenCode, Copilot) has no
     * hook behind it, so this is the only way it reaches a phone with phren
     * closed. Each dialog is pushed once; a pane that stops waiting drops it. */
    observeWaitingPanes(server: string, panes: Json[], resolve: (pane: Json) => Promise<Target | undefined>): Promise<void>;
    private adoptReleasedHold;
    private dropDialogPush;
    /** Approve picks the dialog's yes/allow row (else its first), Deny its
     * no/deny row (else Escape), typed as the pane's own keys. */
    private answerDialog;
    private dropPushBindings;
    /** A server request from one of the Hook's own Codex app-servers: an
     * approval card like a held PermissionRequest, pushed the same way, but
     * with no hold timer. The request stays parked in Codex until someone
     * answers it, here or in the pane's TUI (`codexResolved`). */
    codexRequest(target: Target, request: PendingServerRequest, answer: (result: Json) => void): void;
    /** Another client (the pane's TUI) answered the request, or this one declined it. */
    codexResolved(target: Target, requestId: AppServerRequestId): void;
    start(): Promise<void>;
    close(): void;
}
/** What a Stop payload says about the turn it ends: the harness's last
 * assistant message (Claude, Codex) and, from Claude Code, the background
 * tasks still in flight, which will wake the conversation again when they
 * finish. Absent fields are left out, so the Hook falls back to the transcript. */
export declare function stopFacts(value: Json): {
    background?: number;
    reply?: string;
};
export declare function agentHook(source: Provider): Promise<void>;
