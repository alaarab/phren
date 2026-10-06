import { objects } from "./protocol.js";
/**
 * Codex's own answer to an async question (`request_user_input_async`), the
 * user message its TUI sends into the running turn:
 *
 *   <send_user_message_question_reply>
 *   [{"answer":"…","question":"…","questionItemId":"[\"request_user_input_async\",\"call_…\",0]"}]
 *   </send_user_message_question_reply>
 *
 * The Hook sends the same message for the phone, reads it back to know which
 * questions are answered, and shows it in chat as the question and answer.
 */
const OPEN = "<send_user_message_question_reply>", CLOSE = "</send_user_message_question_reply>";
export function formatQuestionReply(id, entries) {
    return `${OPEN}\n${JSON.stringify(entries.map((entry, index) => ({ answer: entry.answer, question: entry.question,
        questionItemId: JSON.stringify(["request_user_input_async", id, index]) })))}\n${CLOSE}`;
}
/** The entries of a question reply, or undefined for any other message.
 * Anything after the closing tag (the files attached to the answer, which
 * Codex joins into the same message) is not part of the entries. */
export function parseQuestionReply(text) {
    const trimmed = text.trim(), end = trimmed.indexOf(CLOSE);
    if (!trimmed.startsWith(OPEN) || end < 0)
        return undefined;
    let rows;
    try {
        rows = JSON.parse(trimmed.slice(OPEN.length, end));
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(rows))
        return undefined;
    const entries = objects(rows).flatMap(row => {
        if (typeof row.answer !== "string" || typeof row.question !== "string")
            return [];
        let id;
        try {
            const item = JSON.parse(String(row.questionItemId));
            if (Array.isArray(item) && typeof item[1] === "string")
                id = item[1];
        }
        catch { /* An answer without a readable item id still reads as text. */ }
        return [{ answer: row.answer, question: row.question, ...(id ? { id } : {}) }];
    });
    return entries.length ? entries : undefined;
}
/** A question reply as chat text: each question quoted, then its answer,
 * then whatever followed the reply in the same text. */
export function readableQuestionReply(text) {
    const entries = parseQuestionReply(text);
    if (!entries)
        return undefined;
    const trimmed = text.trim(), rest = trimmed.slice(trimmed.indexOf(CLOSE) + CLOSE.length).trim();
    const answers = entries.map(entry => entry.question.split("\n").map(line => `> ${line}`).join("\n") + "\n\n" + entry.answer).join("\n\n");
    return rest ? `${answers}\n\n${rest}` : answers;
}
