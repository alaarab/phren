import { z } from "zod";
import { type Json, type Target } from "./protocol.js";
import type { AppServerRequestId, PendingServerRequest } from "./codex-app-server.js";
import type { CodexServerEntry } from "./codex-servers.js";
declare const question: z.ZodObject<{
    title: z.ZodString;
    options: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString>>>;
}, z.core.$strip>;
type Question = z.infer<typeof question>;
/** Codex's asynchronous questions return {accepted:true} immediately. Their
 * answers are ordinary user messages quoting the original title, not replies
 * to item/tool/requestUserInput (that RPC is the synchronous tool). */
export declare function asyncQuestion(raw: Json, id: string): Question[] | undefined;
/** An `item_completed` event for an AgentMessage delivered async with
 * questions attached: the newer shape, already acknowledged by nature. */
export declare function deliveredQuestion(raw: Json): {
    id: string;
    questions: Question[];
} | undefined;
export declare function questionReply(questions: Question[], answers: unknown): string;
/** The same answers as Codex's own TUI sends them into the running turn. */
export declare function asyncQuestionReply(id: string, questions: Question[], answers: unknown): string;
interface PendingQuestion {
    id: string;
    questions: Question[];
}
export declare function pendingAsyncQuestions(file: string, targetID?: string): Promise<PendingQuestion[]>;
export declare function pendingAsyncQuestion(file: string, id: string): Promise<Question[]>;
/** The Hook's own Codex app-servers (codex-servers.ts), as far as questions go. */
export interface ServedCodex {
    forTarget(target: Target): CodexServerEntry | undefined;
    steer(entry: CodexServerEntry, text: string, extra?: Json[]): Promise<{
        turnId: string;
    }>;
    questions(entry: CodexServerEntry): PendingServerRequest[];
    answerQuestion(entry: CodexServerEntry, requestId: AppServerRequestId, result: Json): boolean;
}
/** A question parked on the app-server as the phone shows it, and the
 * server's answer for the phone's choices. */
interface ServerQuestion {
    questions: Question[];
    result(values: string[]): Json;
    attachments: boolean;
}
/** Files the phone attached to an answer, named the way the phone names them
 * under a chat message it sends with attachments. */
export declare const attachedFiles: (paths: string[]) => string;
/** The phone's attachments for an answer: at most eight of this conversation's uploads. */
export declare function answerAttachments(session: string, data: Json): Promise<string[]>;
/** `item/tool/requestUserInput` (the synchronous tool) and a form MCP
 * elicitation whose fields are all single values. Secret inputs, URL
 * elicitations and multi-select fields stay in the pane. */
export declare function serverQuestion(request: PendingServerRequest): ServerQuestion | undefined;
export declare class CodexQuestions {
    private readonly configured?;
    private readonly served?;
    private snapshots;
    private failedSnapshots;
    private inboxAvailable;
    /** Feature discovery must never delay permission/status frames. */
    get available(): boolean;
    private probe?;
    /** No executable: the real `codex` on PATH, past phren's session wrapper.
     * `served` answers panes on the Hook's own app-server over that server. */
    constructor(configured?: string | undefined, served?: ServedCodex | undefined);
    /** Whether the phone can answer this pane's questions: a pane on the Hook's
     * own app-server always can; any other needs `codex queue`. */
    availableFor(target: Target): boolean;
    private get executable();
    supported(): Promise<boolean>;
    pending(target: Target): Promise<Json[]>;
    private transcriptPending;
    answer(target: Target, data: Json): Promise<void>;
}
export {};
