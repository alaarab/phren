import { type Json, type Target } from "./protocol.js";
/** Claude Code's `/btw` side questions from the phone.
 *
 * `/btw <question>` asks a quick question while Claude keeps working. Claude
 * 2.1.280 draws the answer in a panel under the conversation and writes
 * nothing to the session JSONL, so the Hook reads the settled panel from the
 * pane, scrolls it for a long answer, closes it with Escape and hands the text
 * to the phone as a `side-answer` frame. Nothing of it enters the transcript. */
export type SideState = "pending" | "answer" | "error" | "cancelled";
export interface SideAnswer {
    id: string;
    question: string;
    state: SideState;
    answer?: string;
}
/** The panel as the pane draws it: the asked questions (this session's
 * history, newest last and cut to the pane's width), the body lines, and
 * whether Claude is still answering. */
export interface SidePanel {
    questions: string[];
    body: string[];
    answering: boolean;
    settled: boolean;
}
/** The question in a `/btw ` prompt for Claude, or undefined for any other text. */
export declare function sideQuestionText(source: string, text: string): string | undefined;
/** Parse the `/btw` panel out of visible pane text, or undefined when none is open. */
export declare function sidePanel(text: string): SidePanel | undefined;
/** Whether the newest question in the panel is the one the Hook asked: the
 * panel cuts a long question to the pane's width with an ellipsis. */
export declare function panelAsks(panel: SidePanel, question: string): boolean;
/** The lines `next` adds below `previous` after the panel scrolled, or
 * undefined when it did not move. Without an overlap the whole window is new. */
export declare function scrolledLines(previous: string[], next: string[]): string[] | undefined;
/** Remove the panel's indentation and the wrap-trailing spaces. */
export declare function answerText(lines: string[]): string;
export declare class SideQuestions {
    private readonly options;
    private records;
    private open;
    constructor(options?: {
        timeoutMs?: number;
        intervalMs?: number;
        openMs?: number;
        keepMs?: number;
    });
    private paneKey;
    private read;
    /** While a side question owns the pane, typed input would land in its panel
     * (`x` clears the history, `f` forks), so every other input waits. */
    assertAvailable(target: Target): void;
    /** The side answers the phone has not dismissed for this conversation. */
    list(target: Target): (SideAnswer & {
        revision: number;
    })[];
    private prune;
    /** Type `/btw <question>` into the Claude pane and watch for its answer.
     * Returns at once; the answer arrives on the transcript stream. */
    ask(target: Target, pane: Json, text: string): Promise<{
        id: string;
    }>;
    /** The phone dismissed the card: cancel a pending question (closing its
     * panel) and stop delivering it. */
    dismiss(target: Target, id: string): {
        ok: true;
    };
    private settle;
    /** Close the panel only while it is still drawn: Escape anywhere else
     * would interrupt Claude's running turn. */
    private close;
    /** Scroll a long answer to its end, stitching the windows by their overlap. */
    private collect;
    private watch;
}
