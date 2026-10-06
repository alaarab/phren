import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { BridgeError, bridgeRoot, object, objects } from "./protocol.js";
import { paneIdentity, validateTarget } from "./herdr.js";
import { transcriptPath } from "./transcripts.js";
import { codexExecutable } from "./codex-binary.js";
import { withTranscriptIndex } from "./transcript-index.js";
import { formatQuestionReply, parseQuestionReply } from "./codex-question-reply.js";
import { IMAGE_NAME, sessionUpload } from "./uploads.js";
const exec = promisify(execFile);
const text = z.string().trim().min(1).max(4000).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t));
const question = z.object({ title: text, options: z.array(text).max(12).nullable().optional() });
const questionSet = z.array(question).min(1).max(8);
/** Codex's asynchronous questions return {accepted:true} immediately. Their
 * answers are ordinary user messages quoting the original title, not replies
 * to item/tool/requestUserInput (that RPC is the synchronous tool). */
export function asyncQuestion(raw, id) {
    const p = object(raw.payload);
    // Codex 0.155 asks through an agent message delivered async, with the
    // questions on the item itself; older versions called a tool.
    const asked = deliveredQuestion(raw);
    if (asked)
        return asked.id === id ? asked.questions : undefined;
    if (raw.type !== "response_item" || p.type !== "function_call" || p.call_id !== id
        || !["request_user_input_async", "functions.request_user_input_async"].includes(String(p.name)))
        return;
    try {
        return questionSet.parse(object(JSON.parse(String(p.arguments))).questions);
    }
    catch {
        return;
    }
}
/** An `item_completed` event for an AgentMessage delivered async with
 * questions attached: the newer shape, already acknowledged by nature. */
export function deliveredQuestion(raw) {
    const p = object(raw.payload), item = object(p.item);
    if (raw.type !== "event_msg" || p.type !== "item_completed" || !["AgentMessage", "agentMessage"].includes(String(item.type))
        || item.delivery !== "async" || !Array.isArray(item.questions) || typeof item.id !== "string" || !item.id)
        return;
    try {
        const questions = questionSet.parse(objects(item.questions).map(q => ({ ...q, options: Array.isArray(q.options) ? q.options : undefined })));
        return { id: item.id.slice(0, 512), questions };
    }
    catch {
        return;
    }
}
/** The phone's answer to each question: one option it chose or its typed text. */
function answerValues(questions, answers) {
    const parsed = z.array(z.object({ optionIndexes: z.array(z.number().int().nonnegative()).max(1), text: z.string().max(4000).optional() })).parse(answers);
    if (parsed.length !== questions.length)
        throw new BridgeError(400, "Answer every question.");
    return questions.map((q, index) => {
        const answer = parsed[index], typed = answer.text?.trim() ?? "", options = q.options ?? [];
        if (answer.optionIndexes.length + (typed ? 1 : 0) !== 1)
            throw new BridgeError(400, "Choose one answer for each question.");
        const value = typed || options[answer.optionIndexes[0]];
        if (!value || !text.safeParse(value).success)
            throw new BridgeError(400, "Choose an available answer.");
        return value;
    });
}
export function questionReply(questions, answers) {
    const values = answerValues(questions, answers);
    return questions.map((q, index) => q.title.split("\n").map(line => `> ${line}`).join("\n") + "\n\n" + values[index]).join("\n\n");
}
/** The same answers as Codex's own TUI sends them into the running turn. */
export function asyncQuestionReply(id, questions, answers) {
    const values = answerValues(questions, answers);
    return formatQuestionReply(id, questions.map((q, index) => ({ question: q.title, answer: values[index] })));
}
const answersQuestions = (reply, questions) => questions.every(q => {
    const quote = q.title.split("\n").map(line => `> ${line}`).join("\n") + "\n\n";
    const index = reply.indexOf(quote);
    return index >= 0 && reply.slice(index + quote.length).trim().length > 0;
});
export async function pendingAsyncQuestions(file, targetID) {
    return withTranscriptIndex(file, async (handle, index) => {
        const replies = [], replied = new Set(), acknowledged = new Set(), resolved = new Set(), seen = new Set(), pending = [];
        let bytes = 0;
        for await (const row of index.rows(handle, index.lines, Math.max(0, index.lines - 10_000))) {
            // An incomplete scan is not evidence that no questions remain. Status
            // omits this field on failure, preserving the phone's known prompts.
            if (!row.bytes || (bytes += row.bytes.length) > 8_388_608)
                throw new BridgeError(413, "The pending question history is too large to verify.");
            let raw;
            try {
                raw = object(JSON.parse(row.bytes.toString()));
            }
            catch {
                continue;
            }
            const delivered = deliveredQuestion(raw);
            if (delivered)
                acknowledged.add(delivered.id);
            if (raw.type !== "response_item" && !delivered)
                continue;
            const p = object(raw.payload), id = delivered ? delivered.id : typeof p.call_id === "string" ? p.call_id : "";
            if (p.type === "message" && p.role === "user") {
                const reply = objects(p.content).map(b => typeof b.text === "string" ? b.text : "").join("\n");
                replies.push(reply);
                // Codex's own answer (its TUI, or the Hook for a pane on its app-server) names the question.
                for (const entry of parseQuestionReply(reply) ?? [])
                    if (entry.id)
                        replied.add(entry.id);
            }
            if (id && ["function_call_output", "custom_tool_call_output"].includes(String(p.type)) && !resolved.has(id) && !acknowledged.has(id)) {
                try {
                    if (object(JSON.parse(String(p.output))).accepted === true)
                        acknowledged.add(id);
                    else
                        resolved.add(id);
                }
                catch {
                    resolved.add(id);
                }
            }
            if (targetID && resolved.has(targetID))
                return [];
            if (!id || !acknowledged.has(id))
                continue;
            const questions = asyncQuestion(raw, id);
            // Codex 0.155 records one question twice under the same id: the
            // request_user_input_async call and the AgentMessage delivered async.
            if (questions && !seen.has(id) && !replied.has(id) && !replies.some(reply => answersQuestions(reply, questions))) {
                pending.push({ id, questions });
                if (pending.length >= 64)
                    throw new BridgeError(413, "Too many pending questions to verify.");
            }
            if (questions)
                seen.add(id);
            if (targetID && questions && id === targetID)
                return pending.filter(p => p.id === targetID);
        }
        if (index.lines > 10_000)
            throw new BridgeError(413, "The pending question history is too large to verify.");
        return pending.reverse();
    });
}
export async function pendingAsyncQuestion(file, id) {
    const pending = (await pendingAsyncQuestions(file, id)).find(p => p.id === id);
    if (!pending)
        throw new BridgeError(409, "This question is no longer pending. Refresh the conversation.");
    return pending.questions;
}
/** Files the phone attached to an answer, named the way the phone names them
 * under a chat message it sends with attachments. */
export const attachedFiles = (paths) => paths.length ? `Attached files on this computer:\n${paths.join("\n")}` : "";
const withAttachments = (answer, paths) => paths.length ? `${answer}\n\n${attachedFiles(paths)}` : answer;
/** The phone's attachments for an answer: at most eight of this conversation's uploads. */
export async function answerAttachments(session, data) {
    const requested = z.array(z.string().max(4096)).max(8).optional().parse(data.attachments) ?? [];
    return Promise.all(requested.map(file => sessionUpload(session, file)));
}
const requestKey = (requestId) => `request:${JSON.stringify(requestId)}`;
const choose = (label, options, typed) => {
    if (!typed && !options.includes(label))
        throw new BridgeError(400, "Choose one of the offered answers.");
    return label;
};
/** `item/tool/requestUserInput` (the synchronous tool) and a form MCP
 * elicitation whose fields are all single values. Secret inputs, URL
 * elicitations and multi-select fields stay in the pane. */
export function serverQuestion(request) {
    const params = request.params;
    if (request.method === "item/tool/requestUserInput") {
        const asked = objects(params.questions);
        if (!asked.length || asked.some(q => q.isSecret === true || typeof q.id !== "string" || typeof q.question !== "string"))
            return undefined;
        const parsed = questionSet.safeParse(asked.map(q => ({ title: q.question,
            options: objects(q.options).map(option => option.label).filter((label) => typeof label === "string") })));
        if (!parsed.success)
            return undefined;
        const questions = parsed.data.map(q => ({ ...q, options: q.options?.length ? q.options : undefined }));
        return { questions, attachments: true, result: values => ({ answers: Object.fromEntries(asked.map((q, index) => [String(q.id),
                    { answers: [choose(values[index], questions[index].options ?? [], q.isOther === true || !questions[index].options)] }])) }) };
    }
    if (request.method !== "mcpServer/elicitation/request" || !["form", "openai/form", "openaiForm"].includes(String(params.mode)))
        return undefined;
    const message = typeof params.message === "string" ? params.message.trim() : "";
    const fields = Object.entries(object(object(params.requestedSchema).properties));
    if (!message || !fields.length || fields.length > 8)
        return undefined;
    const shaped = [];
    for (const [key, raw] of fields) {
        const field = object(raw), label = [field.title, field.description].find((value) => typeof value === "string" && !!value.trim())?.trim() ?? key;
        if (field.type === "boolean") {
            shaped.push({ key, title: label, options: ["Yes", "No"], value: answer => choose(answer, ["Yes", "No"], false) === "Yes" });
            continue;
        }
        if (field.type === "number" || field.type === "integer") {
            shaped.push({ key, title: label, value: answer => {
                    const number = Number(answer.trim());
                    if (!answer.trim() || !Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number)))
                        throw new BridgeError(400, `Answer "${label}" with a number.`);
                    return number;
                } });
            continue;
        }
        if (field.type !== "string")
            return undefined;
        const titled = objects(field.oneOf).filter(option => typeof option.const === "string" && typeof option.title === "string");
        const plain = Array.isArray(field.enum) ? field.enum.filter((value) => typeof value === "string") : [];
        const names = Array.isArray(field.enumNames) ? field.enumNames : [];
        const pairs = titled.length ? titled.map(option => [String(option.title), String(option.const)])
            : plain.map((value, index) => [typeof names[index] === "string" ? String(names[index]) : value, value]);
        if (pairs.length) {
            const options = pairs.map(([title]) => title);
            shaped.push({ key, title: label, options, value: answer => pairs[options.indexOf(choose(answer, options, false))][1] });
        }
        else
            shaped.push({ key, title: label, value: answer => answer });
    }
    // The server's message heads the first question; one field reads as the message itself.
    const titles = shaped.map((field, index) => shaped.length === 1 ? (field.title === field.key ? message : `${message}\n\n${field.title}`)
        : index === 0 ? `${message}\n\n${field.title}` : field.title);
    const parsed = questionSet.safeParse(shaped.map((field, index) => ({ title: titles[index], ...(field.options ? { options: field.options } : {}) })));
    if (!parsed.success)
        return undefined;
    return { questions: parsed.data, attachments: false, result: values => ({ action: "accept", content: Object.fromEntries(shaped.map((field, index) => [field.key, field.value(values[index])])) }) };
}
export class CodexQuestions {
    configured;
    served;
    snapshots = new Map();
    failedSnapshots = new Map();
    inboxAvailable = false;
    /** Feature discovery must never delay permission/status frames. */
    get available() { void this.supported(); return this.inboxAvailable; }
    probe;
    /** No executable: the real `codex` on PATH, past phren's session wrapper.
     * `served` answers panes on the Hook's own app-server over that server. */
    constructor(configured, served) {
        this.configured = configured;
        this.served = served;
    }
    /** Whether the phone can answer this pane's questions: a pane on the Hook's
     * own app-server always can; any other needs `codex queue`. */
    availableFor(target) { return target.source === "codex" && (!!this.served?.forTarget(target) || this.available); }
    get executable() { return this.configured ?? codexExecutable(); }
    supported() {
        if (!this.probe || Date.now() - this.probe.at > 300_000)
            this.probe = { at: Date.now(), result: exec(this.executable, ["queue", "--help"], { timeout: 5000, maxBuffer: 65_536 })
                    .then(({ stdout }) => stdout.includes("--thread") && stdout.includes("--message")).catch(() => false)
                    .then(available => { this.inboxAvailable = available; return available; }) };
        return this.probe.result;
    }
    async pending(target) {
        if (target.source !== "codex")
            return [];
        const entry = this.served?.forTarget(target);
        const parked = entry ? this.served.questions(entry).flatMap(request => {
            const shown = serverQuestion(request);
            return shown ? [{ toolUseId: requestKey(request.requestId), isAsync: true, submitted: false, questions: asPrompt(shown.questions) }] : [];
        }) : [];
        return [...parked, ...await this.transcriptPending(target)];
    }
    async transcriptPending(target) {
        if (Date.now() - (this.failedSnapshots.get(target.session) ?? 0) < 5000)
            throw new BridgeError(503, "Pending question history is unavailable.");
        const file = await transcriptPath("codex", target.session);
        const cached = this.snapshots.get(target.session);
        let pending = cached?.pending;
        if (!cached || Date.now() - cached.at > 1000) {
            const metadata = await stat(file), stamp = `${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
            pending = cached?.stamp === stamp ? cached.pending : await pendingAsyncQuestions(file).catch(error => {
                if (this.failedSnapshots.size >= 64)
                    this.failedSnapshots.delete(this.failedSnapshots.keys().next().value);
                this.failedSnapshots.set(target.session, Date.now());
                throw error;
            });
            this.failedSnapshots.delete(target.session);
            if (this.snapshots.size >= 64)
                this.snapshots.delete(this.snapshots.keys().next().value);
            this.snapshots.set(target.session, { at: Date.now(), stamp, pending });
        }
        return Promise.all((pending ?? []).map(async (p) => {
            const key = createHash("sha256").update(JSON.stringify([target.source, target.session, p.id])).digest("hex");
            const submitted = await readFile(path.join(bridgeRoot(), "question-replies", key), "utf8").then(value => value === "submitted").catch(() => false);
            return { toolUseId: p.id, isAsync: true, submitted, questions: asPrompt(p.questions) };
        })).then(prompts => prompts.filter(p => !p.submitted));
    }
    async answer(target, data) {
        const id = z.string().min(1).max(512).parse(data.toolUseId);
        const entry = target.source === "codex" ? this.served?.forTarget(target) : undefined;
        if (entry && id.startsWith("request:")) {
            // A question parked on the Hook's own app-server: the answer is the
            // reply to that request, exactly once, from whichever client is first.
            const request = this.served.questions(entry).find(candidate => requestKey(candidate.requestId) === id);
            const shown = request && serverQuestion(request);
            if (!request || !shown)
                throw new BridgeError(409, "This question is no longer pending. Refresh the conversation.");
            const files = await answerAttachments(target.session, data);
            if (files.length && !shown.attachments)
                throw new BridgeError(400, "This question takes no attachments.");
            const result = shown.result(answerValues(shown.questions, data.answers));
            // Files ride on the last answer, the way a chat message carries them.
            const answers = object(result.answers), last = Object.keys(answers).at(-1);
            if (files.length && last) {
                const values = object(answers[last]).answers;
                answers[last] = { answers: [...values.slice(0, -1), withAttachments(values.at(-1) ?? "", files)] };
            }
            if (!this.served.answerQuestion(entry, request.requestId, result))
                throw new BridgeError(409, "This question is no longer pending. Refresh the conversation.");
            return;
        }
        if (target.source !== "codex" || (!entry && !await this.supported()))
            throw new BridgeError(409, "This connection needs the question answered in the terminal.");
        z.string().uuid().parse(target.session);
        const questions = await pendingAsyncQuestion(await transcriptPath("codex", target.session), id);
        const files = await answerAttachments(target.session, data);
        // A pane on the Hook's app-server gets the answer in its running turn, as
        // Codex's TUI sends it; `codex queue` would hold it until the turn ends.
        // Attached pictures go in as images, and every file is named below.
        const reply = entry ? asyncQuestionReply(id, questions, data.answers) : withAttachments(questionReply(questions, data.answers), files);
        const extra = entry && files.length ? [{ type: "text", text: attachedFiles(files), text_elements: [] },
            ...files.filter(file => IMAGE_NAME.test(file)).map(file => ({ type: "localImage", path: file }))] : [];
        const pane = await validateTarget(target);
        if (await paneIdentity(target.server, pane, true) !== target.session)
            throw new BridgeError(409, "This pane's conversation changed. Reopen the chat.");
        // Record before invoking the provider: a timeout can mean it accepted the
        // message. Concurrent taps, reconnects, and helper restarts must not resend.
        const directory = path.join(bridgeRoot(), "question-replies");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const key = createHash("sha256").update(JSON.stringify([target.source, target.session, id])).digest("hex");
        const receiptPath = path.join(directory, key);
        const receipt = await open(receiptPath, "wx", 0o600).catch(error => {
            if (error.code === "EEXIST")
                throw new BridgeError(409, "An answer was already submitted. Check the conversation before answering again.");
            throw new BridgeError(503, "Phren could not record this answer. Nothing was sent.");
        });
        await receipt.close();
        try {
            // Explicit UUID, no session-name lookup, no shell, no terminal keystrokes.
            if (entry)
                await this.served.steer(entry, reply, extra);
            else
                await exec(this.executable, ["queue", "--thread", target.session, "--message", reply], { timeout: 8000, maxBuffer: 65_536 });
            await writeFile(receiptPath, "submitted", { mode: 0o600 });
        }
        catch {
            throw new BridgeError(409, "Codex did not confirm the answer. Check the conversation; Phren has not retried it.");
        }
    }
}
/** Questions in the phone's pending-question shape: labelled options, or a
 * typed answer when there are none. */
function asPrompt(questions) {
    return questions.map(q => ({ question: q.title, options: (q.options ?? []).map(label => ({ label })), ...(!q.options?.length ? { kind: "text" } : {}) }));
}
