import { type Json } from "./protocol.js";
interface TerminalChoiceOption {
    label: string;
    description?: string;
    key: string;
    hasKey?: boolean;
}
/** The actual question a terminal dialog is asking, when its command and
 * options are visible to the Hook: a title, the command it is about, and one
 * row per choice. For keyless rows, key identifies the option to the phone;
 * the Hook navigates from highlightedIndex instead of typing that number. */
export interface TerminalChoice {
    title?: string;
    body?: string;
    options: TerminalChoiceOption[];
    highlightedIndex?: number;
}
export declare function unframed(text: string): string;
export declare function visibleTerminalChoice(text: string): TerminalChoice | undefined;
/** OpenCode's permission prompt, read from the pane with its colors:
 * "△ Permission required", what it asks, then one row "Allow once  Allow
 * always  Reject" answered with ←/→ and Enter (Escape rejects). The row's
 * selected option is the one drawn on a background the others don't share.
 * The phone gets Allow once and Reject: Allow always opens OpenCode's own
 * second confirmation. `selected` is the cursor's index in the three-option
 * row; undefined when the colors do not say. */
export declare function opencodePermissionDialog(ansi: string): {
    choice: TerminalChoice;
    selected?: number;
} | undefined;
/** The pane's last non-empty line is a password read: sudo's "[sudo] password
 * for user", or any "… Password:" prompt. */
export declare function passwordLine(text: string): boolean;
/** The numbered dialog Claude Code and opencode draw straight in the pane when
 * a permission ask falls back to the terminal (no PermissionRequest hook
 * fires): the last non-empty line above the first "1." row is the question,
 * each row is an option keyed by its own number with its text cut at the first
 * " · ", and a footer offering "Esc to cancel" gains the Escape option.
 * Undefined without two numbered rows and a question. */
export declare function numberedDialog(text: string): TerminalChoice | undefined;
/** Read the question a terminal dialog is asking from the request it carries:
 * an explicit options list, or numbered lines inside its text. Undefined when
 * there are not at least two answerable choices. */
export declare function terminalChoice(input: unknown): TerminalChoice | undefined;
/** Normalize a held permission without turning its arguments into a question. */
export declare function permissionPrompt(tool: string, input: unknown, terminalText?: string): {
    title?: string;
    details: string;
    choice?: TerminalChoice;
    terminalOnly: boolean;
};
/** Claude Code's AskUserQuestion input, normalized to the shape the phone
 * already decodes for a held permission request: one question per entry with
 * its header, multi-select flag and options. Undefined when nothing parses. */
export interface TerminalQuestion {
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: {
        label: string;
        description?: string;
        preview?: string;
    }[];
}
export declare function terminalQuestions(input: unknown): TerminalQuestion[] | undefined;
/** The current question of a released AskUserQuestion as a terminal choice:
 * its labels keyed "1".."n", and a "Done" Enter for a multi-select question
 * whose answers are confirmed by leaving it. */
export declare function questionChoice(questions: TerminalQuestion[], index: number): TerminalChoice | undefined;
export declare function answeredQuestionInput(tool: string, input: unknown, updatedInput: unknown): Json;
export {};
