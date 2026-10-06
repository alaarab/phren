export interface QuestionReplyEntry {
    answer: string;
    question: string;
    id?: string;
}
export declare function formatQuestionReply(id: string, entries: {
    question: string;
    answer: string;
}[]): string;
/** The entries of a question reply, or undefined for any other message.
 * Anything after the closing tag (the files attached to the answer, which
 * Codex joins into the same message) is not part of the entries. */
export declare function parseQuestionReply(text: string): QuestionReplyEntry[] | undefined;
/** A question reply as chat text: each question quoted, then its answer,
 * then whatever followed the reply in the same text. */
export declare function readableQuestionReply(text: string): string | undefined;
