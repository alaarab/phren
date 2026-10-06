// What a pane's agent last said about its own turns, from its lifecycle hooks:
// when a prompt was submitted, when the turn stopped, what it stopped with and
// whether the harness still had background work in flight. Dispatch returns
// answer from this record first (dispatch-returns.ts `workerStates`): a
// worker is done only once a Stop arrived after its prompt, never because it
// has looked idle for a while.
//
// Claude, Codex, Copilot and phren-agent send SessionStart, UserPromptSubmit
// and Stop to the Hook (agent-hooks.ts), which records them here, one small
// file per pane beside its binding. OpenCode has no such hooks; phren's
// OpenCode plugin stamps its turns into the per-PID status file instead
// (`opencodeTurn`).
//
// The record is keyed by pane and holds the latest conversation there, with
// the dispatch id (PHREN_DISPATCH_ID) its SessionStart or first prompt named,
// so a dispatch placed on this computer is matched by id as well as by pane
// and conversation.
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { opencodeTurnStamps } from "./harness-status.js";
import { briefId } from "./launch-brief.js";
import { atomicInPrivateDir, bridgeRoot, provider, serverName, sessionId } from "./protocol.js";
/** Longest final reply kept from a Stop payload, in UTF-8 bytes (the receipt's limit). */
export const TURN_REPLY_LIMIT = 4000;
const MAX_RECORD_BYTES = 16_384;
const stamp = z.object({ seq: z.number().int().min(0), at: z.string().datetime() }).strict();
const turnRecordSchema = z.object({
    terminal: z.string().min(1).max(200), source: provider, session: sessionId,
    /** Climbs with every recorded event, so prompt and stop are ordered without trusting the clock. */
    seq: z.number().int().min(0),
    /** The dispatch this conversation was launched for, as its hooks named it. */
    dispatch: briefId.optional(),
    startedAt: z.string().datetime().optional(),
    prompt: stamp.optional(),
    stop: stamp.extend({
        /** Background tasks (shells, subagents, monitors) the harness still ran when the turn stopped. */
        background: z.number().int().min(0).max(999).optional(),
        reply: z.string().max(TURN_REPLY_LIMIT).optional(), truncated: z.boolean().optional(),
    }).strict().optional(),
    at: z.string().datetime(),
}).strict();
export const turnPath = (server, pane) => path.join(bridgeRoot(), "turns", encodeURIComponent(serverName.parse(server)), encodeURIComponent(pane) + ".json");
/** `value` cut to at most `limit` UTF-8 bytes on a character boundary. */
export function truncateUtf8(value, limit = TURN_REPLY_LIMIT) {
    const bytes = Buffer.from(value);
    if (bytes.length <= limit)
        return { text: value, truncated: false };
    let end = limit;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80)
        end--;
    return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
/** The record after one lifecycle event; undefined for events that say nothing about turns.
 * Another conversation or terminal in the pane starts a fresh record. */
export function nextTurn(previous, event) {
    if (!["SessionStart", "UserPromptSubmit", "Stop"].includes(event.event))
        return undefined;
    const at = new Date(event.at ?? Date.now()).toISOString();
    const same = previous && previous.terminal === event.terminal && previous.source === event.source && previous.session === event.session;
    const record = same ? structuredClone(previous) : { terminal: event.terminal, source: event.source, session: event.session, seq: 0, at };
    record.seq++;
    record.at = at;
    if (event.dispatch && briefId.safeParse(event.dispatch).success)
        record.dispatch ??= event.dispatch;
    if (event.event === "SessionStart")
        record.startedAt ??= at;
    else if (event.event === "UserPromptSubmit")
        record.prompt = { seq: record.seq, at };
    else {
        const reply = event.reply?.trim() ? truncateUtf8(event.reply.trim()) : undefined;
        record.stop = { seq: record.seq, at, ...(event.background !== undefined ? { background: Math.min(999, Math.max(0, Math.floor(event.background))) } : {}),
            ...(reply ? { reply: reply.text, ...(reply.truncated ? { truncated: true } : {}) } : {}) };
    }
    return record;
}
/** Where the recorded conversation is: no prompt yet, a prompt with no Stop
 * after it, or a turn that stopped. A Stop with no recorded prompt (hooks
 * installed mid-conversation) still ended a turn. */
export function turnPhase(record) {
    const { prompt, stop } = record;
    if (prompt && (!stop || stop.seq < prompt.seq))
        return { phase: "working", since: prompt.at };
    if (!stop)
        return { phase: "unprompted" };
    return { phase: "ended", at: stop.at, ...(stop.background ? { background: stop.background } : {}),
        ...(stop.reply ? { reply: stop.reply, ...(stop.truncated ? { truncated: true } : {}) } : {}) };
}
async function readRecord(file) {
    try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > MAX_RECORD_BYTES)
            return undefined;
        const parsed = turnRecordSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
        return parsed.success ? parsed.data : undefined;
    }
    catch {
        return undefined;
    }
}
let writes = Promise.resolve();
/** Record one lifecycle event for `pane`. Writes run one at a time, so a Stop
 * and the next prompt arriving together keep their order. */
export function noteTurn(server, pane, event) {
    const run = writes.then(async () => {
        const file = turnPath(server, pane);
        const next = nextTurn(await readRecord(file), event);
        if (next)
            await atomicInPrivateDir(file, turnRecordSchema.parse(next));
        return next;
    });
    writes = run.catch(() => undefined);
    return run;
}
/** The recorded turns of `pane`'s latest conversation, if its hooks reported any. */
export function readTurn(server, pane) {
    return readRecord(turnPath(server, pane));
}
/** OpenCode's turns for a pane running `pids`, from the stamps phren's OpenCode
 * plugin writes on session.status busy / session.idle; undefined for an older
 * plugin that writes none. `terminal` is the pane's, since the PIDs are. */
export async function opencodeTurn(pids, terminal) {
    const stamps = await opencodeTurnStamps(pids);
    if (!stamps)
        return undefined;
    const busy = stamps.busyAt ? Date.parse(stamps.busyAt) : NaN, idle = stamps.idleAt ? Date.parse(stamps.idleAt) : NaN;
    const parsed = turnRecordSchema.safeParse({ terminal, source: "opencode", session: stamps.session, seq: 2, at: stamps.at,
        ...(Number.isFinite(busy) ? { prompt: { seq: 1, at: stamps.busyAt } } : {}),
        // The plugin stamps idle after busy; an idle stamp older than the busy one belongs to an earlier turn.
        ...(Number.isFinite(idle) && !(idle < busy) ? { stop: { seq: 2, at: stamps.idleAt } } : {}) });
    return parsed.success ? parsed.data : undefined;
}
