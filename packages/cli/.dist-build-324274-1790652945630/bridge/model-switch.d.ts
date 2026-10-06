import { AgentHooks } from "./agent-hooks.js";
import { ModelCatalog, type AgentModel } from "./models.js";
import { type Json, type Target } from "./protocol.js";
export declare const MODEL_BUSY = "This agent is working. The model switch can happen when the turn ends. Choose Switch after this turn.";
export declare const SLASH_BUSY = "This agent is working. Slash commands run between turns; send it again when this turn ends.";
/** Busy slash commands must never enter the harness's text queue. Claude's
 * `/btw` side question is the one made to run beside a working turn. Only
 * `/model` is told about the model switch; any other command (`/yolo`,
 * `/compact`) is told it runs between turns. */
export declare function refuseWorkingSlash(pane: Json, text: string, source?: string): void;
/** The levels Claude Code's `/effort` takes (2.1.280) when the catalogue
 * lists none for a model; Claude still refuses one the model lacks. */
export declare const CLAUDE_EFFORTS: string[];
type EffortReply = {
    effort: string;
} | {
    error: string;
};
/** Claude Code's first reply to `/effort <level>` below its latest "Set model
 * to" line, the switch this transaction just verified, so an older reply in
 * the scrollback never confirms. A cap reports the level actually set; an
 * override or refusal is an error. */
export declare function claudeEffortReply(text: string): EffortReply | undefined;
/** Empty prompts can draw a dim placeholder. Only ANSI evidence that every
 * character after the prompt is dim distinguishes that from a person's draft. */
export declare function emptyComposer(line: string): boolean;
/** Only a footer below Codex's empty composer proves the active model. Text
 * in history, a menu, or the startup banner must never confirm a switch. */
export declare function codexModelStatus(text: string, model: AgentModel): boolean;
/** One model transaction owns terminal input until it finishes or escapes. */
export declare class ModelSwitcher {
    private readonly hooks;
    private readonly catalog;
    private readonly timeout;
    private active;
    constructor(hooks: AgentHooks, catalog?: ModelCatalog, timeout?: number);
    private key;
    assertAvailable(target: Target): void;
    switch(target: Target, data: Json): Promise<Json>;
}
export {};
