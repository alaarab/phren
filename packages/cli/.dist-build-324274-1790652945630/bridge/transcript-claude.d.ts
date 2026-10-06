import { type Json } from "./protocol.js";
import type { ChildAgentRelation } from "./transcripts.js";
/** The checkout a Claude sub-agent edits in. Claude Code writes the isolated
 * worktree into the child's `.meta.json`; an older child falls back to the
 * `cwd` its own first rows record when that folder is a linked worktree (its
 * `.git` is a file). A child working in the parent's checkout gets nothing,
 * and a worktree already removed is not offered. */
export declare function claudeChildCheckout(file: string): Promise<Pick<ChildAgentRelation, "cwd" | "worktreeName" | "branch">>;
export declare function claudeChildAgents(file: string, session: string): Promise<ChildAgentRelation[]>;
export declare const harnessPreamble: (text: string) => boolean;
export declare function unwrapPastedContent(text: string): string;
/** A thinking block Claude marks as narration for the person watching: its
 * signature is a length-prefixed field reading "narration" (private
 * reasoning reads "thinking" and is stored without text). */
export declare function isNarration(block: Record<string, unknown>): boolean;
/** What a Skill call loaded. Claude Code answers the call itself with only
 * "Launching skill: <name>" and writes the skill's text as a hidden user row
 * pointing back at the call (`sourceToolUseID`). That row alone crosses, as a
 * second result for the same call, so the phone can show what the skill said;
 * every other hidden row stays private. */
export declare function skillBody(raw: Json): Json | undefined;
/** A phren UserPromptSubmit injection, as `{ type: "phren_hook_context",
 * parentUuid, content }`, or undefined for any other row. */
export declare function phrenHookContext(raw: Json, includeSidechain?: boolean): Json | undefined;
/** Claude Code rows the phone may see: user, assistant and system turns with
 * private reasoning redacted, queued phone messages, background task
 * notifications and compaction markers. */
export declare function visibleClaudeEvent(raw: Json, includeSidechain?: boolean): Json | undefined;
