/** Claude Code's AskUserQuestion dialog as the pane draws it, and a walk that
 * answers it one verified key at a time. Claude's keys are not uniform: a
 * digit on a single-select question picks the row and moves to the next
 * question on its own, a digit on a multi-select question only toggles its
 * box, Tab leaves a multi-select question (or, from the typed "Other" row,
 * moves to its Next row), and a set of more than one question, or any
 * multi-select question, ends on a "Review your answers" tab that "1"
 * submits. Blind key sequences drift onto the wrong tab, so every step reads
 * the pane first and checks the result before the next. */
interface Row {
    number: number;
    label: string;
    checked?: boolean;
    answered: boolean;
    cursor: boolean;
}
export interface ClaudeQuestionScreen {
    kind: "question";
    /** Headers from the tab bar, without the trailing Submit tab. */
    tabs: string[];
    title: string;
    multiSelect: boolean;
    /** The asked options, in order; the typed "Other" row is `other`. */
    options: Row[];
    other?: Row;
    /** The row number under the cursor, or "next" on a multi-select Next/Submit row. */
    cursor?: number | "next";
}
export interface ClaudeReviewScreen {
    kind: "review";
    tabs: string[];
    answers: {
        question: string;
        answer: string;
    }[];
}
export type ClaudeDialogScreen = ClaudeQuestionScreen | ClaudeReviewScreen;
/** The question dialog the pane is drawing now, or undefined when the last
 * lines are not one: the last tab bar anchors it, and an active dialog ends
 * with its "Esc to cancel" footer or the review's Submit/Cancel rows. */
export declare function claudeQuestionDialog(text: string): ClaudeDialogScreen | undefined;
export interface DialogQuestion {
    question: string;
    multiSelect?: boolean;
    options: {
        label: string;
    }[];
}
/** Option indexes into the question's options, plus a typed "Other" answer. */
export interface DialogAnswer {
    options: number[];
    text?: string;
}
export interface DialogIO {
    read(): Promise<string>;
    keys(keys: string[]): Promise<void>;
    sleep?(ms: number): Promise<void>;
}
/** Answer `answers[i]` for question `from + i`, then submit the set when
 * `submit` is true. Each step is checked against a fresh read of the pane. */
export declare function answerClaudeQuestionDialog(io: DialogIO, questions: DialogQuestion[], answers: DialogAnswer[], options?: {
    from?: number;
    submit?: boolean;
}): Promise<void>;
export {};
