import { type Json } from "./protocol.js";
import type { Entry, LocalChildAgentRelation } from "./transcripts.js";
/** Codex's transcript reader: SubAgentActivity child links, the public rows
 * of a rollout, and code-mode calls projected into ordinary tool calls. */
export type DirectRelation = Pick<LocalChildAgentRelation, "session" | "path" | "callId" | "state">;
export declare function directChildAgents(file: string): Promise<DirectRelation[]>;
export declare function childTranscriptBelongsTo(file: string, parent: string): Promise<boolean>;
export declare function visibleCodexEvent(raw: Json): Json | undefined;
export interface CodeModeWrapper {
    callId: string;
    images: string[];
}
/** A numbered rollout's code-mode `exec` call whose every tool call is
 * recorded as an item. A script that calls anything else stays as it is. */
export declare function codeModeWrapper(raw: Json): CodeModeWrapper | undefined;
/** The wrapper a numbered rollout's code-mode result answers, by call id. */
export declare function codeModeOutputCall(raw: Json): string | undefined;
/** A covered wrapper's result: an image viewer keeps only its pictures, a
 * "Script completed"/"Script running" status is hidden (the items carry the
 * actions), and a failure or abort is listed with the script it ended, whose
 * own row was hidden, so the phone draws the pair. */
export declare function projectCodeModeOutput(raw: Json, call: Json | undefined): Json | undefined;
/** The wrapper call a result answers, found within the rows just before it
 * (a script's own items sit between the two; 32 rows apart at most seen). */
export declare function findCodeModeCall(rows: (before: number, after: number) => AsyncIterable<{
    line: number;
    bytes?: Buffer;
}>, line: number, callId: string): Promise<Json | undefined>;
/** Codex 0.155 code mode: the model calls one generic tool whose input is
 * JavaScript, and that source invokes `tools.apply_patch`/`tools.shell`/
 * `tools.read`. The Hook resolves each invocation into the ordinary call the
 * phone already draws, so a patch shows a diff instead of an opaque source. */
export interface CodeToolCall {
    name: "apply_patch" | "shell" | "read";
    input: Json;
}
/** Every recognized invocation in a code-mode source, in the order written. */
export declare function codeToolCalls(source: string): CodeToolCall[] | undefined;
/** Expand one Codex row: a code-mode call becomes one ordinary call per
 * invocation, each carrying the original source under `input.source`, and the
 * matching result follows the first. Other rows pass through unchanged. */
export declare function projectCodexRow(raw: Json): {
    rows: Json[];
    base?: string;
};
/** The output row for a projected call is read before its call (newest row
 * first), so an output already collected in this page follows the first. */
export declare function rewriteProjectedOutput(entries: Entry[], base: string): void;
