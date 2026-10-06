import { type Target } from "./protocol.js";
import type { Entry } from "./transcripts.js";
export interface TranscriptPreview {
    turnStartedAt: string;
    text: string;
}
export declare const PREVIEW_INTERVAL_MS = 500;
/** Only the last Claude reply after the current prompt is eligible. A missing
 * prompt anchor is deliberately silent: scrollback could belong to an old turn. */
export declare function claudePanePreview(rendered: string, prompt: string, previous?: string): string;
/** An unbulleted tool-group summary line, e.g. "  Read 1 file, ran 1 shell command". */
export declare function claudeToolSummary(line: string): boolean;
/**
 * Claude Code's own screen text, never part of a reply: the update and
 * restart notices, status lines it marks ✔ / ✗ / ⚠ / ※, tips, and the
 * context and auto-accept hints drawn around the input box.
 */
export declare function claudeChrome(line: string): boolean;
/**
 * Undoes the terminal's word wrap. Claude draws a paragraph wrapped to the
 * pane's width, so the phone would show each wrap as a hard break. A line is
 * joined to the next when the next line's first word would not have fitted
 * on it, which is exactly what a soft wrap looks like; the widest line
 * stands in for the pane width, and below 40 columns nothing is joined. Blank lines, block starts and fenced code
 * keep their breaks. `display` is what is joined, line for line: the text
 * with Markdown put back, measured by its plain twin.
 */
export declare function unwrapTerminalLines(lines: readonly string[], display?: readonly string[]): string;
/** Claude's spinner line, as structured fields: the verb, the turn's elapsed
 * seconds, the token count and its direction, and whether it is thinking.
 * "✻ Whirlpooling… (27s · ↓ 2.3k tokens · thinking)". */
export interface ClaudeSpinner {
    verb: string;
    elapsed?: number;
    tokens?: {
        count: number;
        direction: "up" | "down";
    };
    thinking: boolean;
    /** "thought for 4s": how long the finished thinking took. */
    thoughtFor?: number;
}
/** One spinner line, or undefined for anything else. The parenthesis must
 * start with a time or say "esc to interrupt", as Claude's does. */
export declare function parseClaudeSpinnerLine(line: string): ClaudeSpinner | undefined;
/** The newest spinner line on screen. */
export declare function claudeSpinner(rendered: string): ClaudeSpinner | undefined;
/** The word Claude's own spinner shows ("✻ Pondering… (12s · esc to interrupt)"). */
export declare function claudeSpinnerVerb(rendered: string): string | undefined;
/** Copilot's reasoning state for the running turn, from the headers it draws
 * above each reasoning block ("⌄ Thought for 16s", "Thinking" while it
 * streams), newest below the turn's prompt line. Only the header is read:
 * the reasoning under it ("│ …") never leaves the Hook. */
export declare function copilotThinking(rendered: string): ClaudeSpinner | undefined;
export declare function readPreviewPane(target: Target): Promise<string>;
/**
 * One pane line as Markdown bold. Claude draws a reply's **bold** with SGR 1
 * and drops the asterisks, so a plain read loses it and the phone's preview
 * would gain it only when the reply lands. Whitespace stays outside the
 * markers (Markdown does not close `**a **`); other styles are dropped.
 */
export declare function claudeBoldMarkdown(line: string): string;
/** Older Codex rollouts may carry public text deltas between response items.
 * Keep a bounded raw cursor, since history intentionally filters these out. */
export declare class CodexRolloutPreview {
    private revision?;
    private cursor;
    private startedAt?;
    private text;
    read(file: string): Promise<TranscriptPreview | null>;
}
export declare function readDeltaPreview(target: Target, file?: string, rollout?: CodexRolloutPreview): Promise<TranscriptPreview | null>;
/** Socket-local, ephemeral state. It never writes transcript rows or advances
 * the history cursor. Final rows bypass the text throttle and clear atomically. */
export declare class TranscriptPreviewStream {
    private readonly target;
    private readonly pane;
    private readonly delta;
    private startedAt?;
    private prompt;
    private landed;
    private ended;
    /** Claude's own spinner word for the running turn, sent beside frames as
     * `activityVerb` for older phones. */
    verb: string | undefined;
    /** The whole spinner line for the running turn, sent as `activity`;
     * phones without it ignore the field. */
    activity: ClaudeSpinner | undefined;
    private sentActivity;
    private lastRead;
    private lastSent;
    private current;
    private observedLine;
    private wasWorking;
    private readonly codexCompleted;
    private readonly rollout;
    constructor(target: Target, pane?: () => Promise<string>, delta?: (file?: string) => Promise<TranscriptPreview | null>);
    observe(entries: Entry[], reset?: boolean): void;
    update(status: unknown, file?: string, now?: number): Promise<{
        preview: TranscriptPreview | null;
    } | undefined>;
}
