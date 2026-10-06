import { readdir, realpath, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { codexHome } from "../home-paths.js";
import { claudeAccountRef, claudeHomeOfPath, claudeHomes } from "./claude-accounts.js";
import { paneAccount, paneAccountKey } from "./pane-accounts.js";
import path from "node:path";
import { withTranscriptIndex } from "./transcript-index.js";
import { BridgeError, object, objects, sessionId } from "./protocol.js";
import { materializeCodexThread, materializedRoot } from "./codex-threads.js";
import { namedPaths, SHELL_TOOLS, outputCallIds } from "./changes.js";
import { fanoutChildren } from "./fanouts.js";
import { claudeChildAgents, visibleClaudeEvent } from "./transcript-claude.js";
import { childTranscriptBelongsTo, codeModeOutputCall, directChildAgents, findCodeModeCall, projectCodeModeOutput, projectCodexRow, rewriteProjectedOutput, visibleCodexEvent } from "./transcript-codex.js";
import { visibleCopilotEvent } from "./transcript-copilot.js";
import { visibleOpencodeEvent } from "./transcript-opencode.js";
export { isNarration, unwrapPastedContent } from "./transcript-claude.js";
export { codeToolCalls, projectCodexRow } from "./transcript-codex.js";
/** Provider-neutral child-agent discovery. Codex currently supplies explicit
 * SubAgentActivity links; other providers return no children until their
 * public transcript format exposes an equivalent relationship. */
export async function childAgentTree(source, session, depth = 0, seen = new Set(), computer = "local") {
    const identity = `${computer}\0${source}\0${session}`;
    if (depth >= 4 || seen.size >= 128 || seen.has(identity))
        return [];
    seen.add(identity);
    const fanouts = (await fanoutChildren(source, session, process.env, computer === "local" ? undefined : computer)).map(child => ({
        ...child, session: child.session ?? child.id, cwd: child.cwd, children: [],
    }));
    if (!["codex", "claude"].includes(source))
        return fanouts;
    const file = await transcriptPath(source, session);
    if (source === "claude")
        return [...await claudeChildAgents(file, session), ...fanouts];
    const relations = await directChildAgents(file), verified = [];
    for (const relation of relations) {
        const childFile = await transcriptPath(source, relation.session).catch(() => undefined);
        if (!childFile || !await childTranscriptBelongsTo(childFile, session))
            continue;
        verified.push({ ...relation, transcript: childFile, provider: source,
            id: createHash("sha256").update(`${source}\0${session}\0${relation.session}`).digest("hex").slice(0, 32),
            children: await childAgentTree(source, relation.session, depth + 1, seen, computer).catch(() => []) });
    }
    return [...verified, ...fanouts];
}
/** Explicit wire projection prevents a provider's private transcript identity
 * from being returned if relation internals grow later. */
export function publicChildAgents(tree) {
    return tree.map(({ id, provider, path: agentPath, callId, state, reason, startedAt, finishedAt, model, worktreeName, branch, computer, remote, fanout, children }) => 
    // A blocked worker is finished; the phone's relation contract has no failed
    // state, so the reason carries what happened without breaking old clients.
    ({ id, provider, path: agentPath, callId, state: state === "failed" || state === "gone" ? "completed" : state,
        ...(state === "failed" || state === "gone" ? { failed: true } : {}),
        ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}),
        ...(reason !== undefined ? { reason } : {}), ...(model !== undefined ? { model } : {}),
        ...(worktreeName !== undefined ? { worktreeName } : {}), ...(branch !== undefined ? { branch } : {}),
        ...(computer !== undefined ? { computer: { id: computer.id, name: computer.name } } : {}),
        ...(remote !== undefined ? { remote: { target: remote.target, ...(remote.child !== undefined ? { child: remote.child } : {}) } } : {}),
        ...(fanout ? { fanout } : {}),
        children: publicChildAgents(children) }));
}
export function childAgent(tree, id) {
    for (const node of tree) {
        if (node.remote !== undefined)
            continue;
        if (node.id === id && node.session !== undefined && node.transcript !== undefined)
            return node;
        const nested = childAgent(node.children, id);
        if (nested)
            return nested;
    }
}
/** Preserve content positions and image types; original bytes stay in the
 * transcript for the separate image route. Only provider content blocks are
 * interpreted, never text strings or arbitrary tool arguments. */
function imageReferences(content, toolResults = false) {
    if (!Array.isArray(content))
        return content;
    return content.map(value => {
        const block = object(value);
        if (["image", "input_image"].includes(String(block.type)))
            return { type: block.type };
        if (toolResults && block.type === "tool_result")
            return { ...block, content: toolOutputReferences(block.content) };
        return value;
    });
}
function toolOutputReferences(output) {
    if (Array.isArray(output))
        return imageReferences(output);
    const result = object(output);
    return Array.isArray(result.content) ? { ...result, content: imageReferences(result.content) } : output;
}
/**
 * The phren store whose `.runtime/sessions` holds phren-agent event logs.
 * `PHREN_PATH` or the shared `~/.phren` root — the two resolutions the CLI's
 * `findPhrenPath` makes without a working directory, which a service has none
 * of. Kept inline rather than importing phren-paths: that module drags in
 * yaml and the data layer, and this bundle is budgeted for cold start.
 */
export function phrenStoreRoot(env = process.env) {
    const configured = env.PHREN_PATH?.trim();
    if (!configured)
        return path.join(homedir(), ".phren");
    const expanded = configured === "~" ? homedir() : configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : configured;
    return path.resolve(expanded);
}
function chatFrame(raw, source) {
    if (source === "phren" || source === "opencode") {
        const data = object(raw.data), message = object(data.message);
        return Array.isArray(message.content)
            ? { ...raw, data: { ...data, message: { ...message, content: imageReferences(message.content, true) } } } : raw;
    }
    if (source === "copilot") {
        const data = object(raw.data);
        return { ...raw, data: { ...data,
                ...(Array.isArray(data.content) ? { content: imageReferences(data.content) } : {}),
                ...(data.result !== undefined ? { result: toolOutputReferences(data.result) } : {}),
            } };
    }
    const key = source === "codex" ? "payload" : "message";
    const message = object(raw[key]);
    if (source === "codex" && ["function_call_output", "custom_tool_call_output"].includes(String(message.type))) {
        return { ...raw, [key]: { ...message, output: toolOutputReferences(message.output) } };
    }
    return Array.isArray(message.content)
        ? { ...raw, [key]: { ...message, content: imageReferences(message.content, source === "claude") } } : raw;
}
/** Compile one path segment to a regexp: `*` and `?` are the only wildcards,
 * neither crosses `/`. */
function segmentRegExp(segment) {
    const source = segment.split(/([*?])/).map(part => {
        if (part === "*")
            return "[^/]*";
        if (part === "?")
            return "[^/]";
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    return new RegExp(`^${source}$`);
}
/** The fixed transcript layouts globbed for: `*` within a single segment, no
 * `**`, dotfiles skipped, symlinked directories not followed. Kept native so
 * the Hook bundle does not carry the `glob` package. */
async function findPatternMatches(root, pattern) {
    const segments = pattern.split("/");
    const expressions = segments.map(segmentRegExp);
    const matches = [];
    const walk = async (dir, index) => {
        const segment = segments[index];
        const last = index === segments.length - 1;
        if (!segment.includes("*") && !segment.includes("?")) {
            const next = path.join(dir, segment);
            try {
                const info = await lstat(next);
                if (last) {
                    // glob returns a symlink to a file here too; the caller's realpath
                    // check is what rejects one pointing outside the provider folder.
                    if (info.isFile() || info.isSymbolicLink())
                        matches.push(next);
                }
                else if (info.isDirectory()) {
                    await walk(next, index + 1);
                }
            }
            catch { /* no match */ }
            return;
        }
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".") || !expressions[index].test(entry.name))
                continue;
            const next = path.join(dir, entry.name);
            if (last) {
                if (entry.isFile() || entry.isSymbolicLink())
                    matches.push(next);
            }
            else if (entry.isDirectory()) {
                await walk(next, index + 1);
            }
        }
    };
    await walk(root, 0);
    return matches;
}
/** The account a resolved Claude transcript belongs to, by the home holding it. */
export function transcriptAccount(file) {
    const home = claudeHomeOfPath(file);
    return home ? claudeAccountRef(home) : undefined;
}
/** A pane's transcript: the pane's known Claude account settles a session id found in more than one home. */
export function targetTranscriptPath(target) {
    const account = target.source === "claude" ? paneAccount(paneAccountKey(target.server, target.pane))?.id : undefined;
    return transcriptPath(target.source, target.session, account);
}
/** `account` (a Claude home id) settles a session id found in more than one home. */
export async function transcriptPath(source, session, account) {
    if (!sessionId.safeParse(session).success)
        throw new BridgeError(400, "Invalid conversation identity.");
    const bases = source === "codex" ? [{ base: path.join(codexHome(), "sessions") }]
        : source === "claude" ? claudeHomes().map(home => ({ id: home.id, base: path.join(home.dir, "projects") }))
            : source === "phren" || source === "opencode" ? [{ base: path.join(phrenStoreRoot(), ".runtime", "sessions") }]
                : [{ base: path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "session-state") }];
    const pattern = source === "codex" ? `*/*/*/rollout-*-${session}.jsonl` : source === "claude" ? `*/${session}.jsonl`
        : source === "phren" ? `session-${session}.events.jsonl` : source === "opencode" ? `opencode-${session}.events.jsonl` : `${session}/events.jsonl`;
    const found = [];
    for (const entry of bases) {
        const root = await realpath(entry.base).catch(() => entry.base);
        const matches = await findPatternMatches(root, pattern).catch(() => []);
        for (const match of matches)
            found.push({ id: entry.id, root, match });
    }
    let chosen = found;
    if (source === "claude" && found.length > 1 && account) {
        const preferred = found.filter(item => item.id === account);
        if (preferred.length)
            chosen = preferred;
    }
    if (chosen.length !== 1) {
        // Codex 0.155 keeps new threads only in its sqlite store; the Hook
        // materializes those into a rollout-shaped file of its own.
        const materialized = source === "codex" ? await materializeCodexThread(session) : undefined;
        if (materialized)
            return materialized;
        throw new BridgeError(404, "The transcript is not available for this conversation.", { code: "transcript-unavailable" });
    }
    const file = await realpath(chosen[0].match);
    if (!file.startsWith(chosen[0].root + path.sep))
        throw new BridgeError(403, "The transcript points outside its agent folder.");
    return file;
}
/** Keeps a materialized Codex thread current before a read; a no-op for
 * transcripts the agent writes itself. */
export async function refreshTranscript(file, source, session) {
    if (source === "codex" && file.startsWith(materializedRoot() + path.sep))
        await materializeCodexThread(session);
}
/** Public conversation/tool events and real usage only. Never export private reasoning. */
export function visibleEvent(raw, source, includeSidechain = false, cwd) {
    if (source === "phren" || source === "opencode")
        return visibleOpencodeEvent(raw, source, cwd);
    if (source === "codex")
        return visibleCodexEvent(raw);
    if (source === "claude")
        return visibleClaudeEvent(raw, includeSidechain);
    return visibleCopilotEvent(raw);
}
/** Parse only the requested page; shared byte indexes make reopening and
 * backward pagination independent of the amount of already-read history. */
export class TranscriptReader {
    file;
    source;
    imageLine;
    changes;
    includeSidechain;
    cwd;
    revision;
    nextLine = 0;
    constructor(file, source, imageLine, changes, includeSidechain = false, cwd) {
        this.file = file;
        this.source = source;
        this.imageLine = imageLine;
        this.changes = changes;
        this.includeSidechain = includeSidechain;
        this.cwd = cwd;
    }
    async read(before, signal) {
        return this.readPage(before, undefined, signal);
    }
    /** Resume a fresh live reader after the last raw line the client retained. */
    async readAfter(afterLine, signal) {
        if (!Number.isSafeInteger(afterLine) || afterLine < 0)
            throw new BridgeError(400, "Invalid transcript cursor.");
        return this.readPage(undefined, afterLine, signal);
    }
    async readPage(before, afterLine, signal) {
        return withTranscriptIndex(this.file, async (handle, index) => {
            const reset = this.revision !== index.revision;
            const end = Math.min(before ?? index.lines, index.lines);
            const resuming = before === undefined && afterLine !== undefined && this.revision === undefined;
            // The phone's cursor can sit past the end after the file was replaced
            // (compaction, a rewritten thread). A resume into that gap is a full
            // snapshot of the new file, flagged as the replacement it is; an
            // in-range resume is only a delta and never claims a replacement.
            const pastEnd = resuming && afterLine >= index.lines;
            const lower = this.imageLine ?? (pastEnd ? 0
                : resuming ? Math.min(afterLine + 1, index.lines)
                    : reset || before !== undefined ? 0 : this.nextLine);
            const entries = [];
            // The first page of a conversation is what the phone parses and lays
            // out before anything shows; keep it light and let scrolling fetch the
            // rest in fuller pages. A live tail (nextLine known) stays small too.
            const opening = before === undefined && (pastEnd || (!resuming && (reset || this.nextLine === 0)));
            const entryBudget = opening ? 60 : 200;
            const byteBudget = opening ? 1_048_576 : 4_194_304;
            let bytes = 0, cursor = end, held;
            for await (const row of index.rows(handle, end, lower, signal)) {
                signal?.throwIfAborted();
                let rows = [];
                try {
                    let raw = row.bytes && visibleEvent(object(JSON.parse(row.bytes.toString())), this.source, this.includeSidechain, this.cwd);
                    // A child agent's transcript is the sidechain. Its rows are that
                    // conversation's own turns, not something for the reader to skip.
                    if (raw && this.includeSidechain && raw.isSidechain === true) {
                        const { isSidechain: _sidechain, ...own } = raw;
                        raw = own;
                    }
                    // A code-mode script's result follows from the script it answers,
                    // a few rows earlier: hidden when its items carry the actions.
                    const codeModeCall = raw && this.source === "codex" ? codeModeOutputCall(raw) : undefined;
                    if (raw && codeModeCall)
                        raw = projectCodeModeOutput(raw, await findCodeModeCall((upper, lower) => index.rows(handle, upper, lower, signal), row.line, codeModeCall));
                    if (raw) {
                        if (this.changes && this.imageLine === undefined) {
                            // A shell call's output carries what it changed on disk. While
                            // that diff is still being computed on the live tail, the row
                            // (and the newer rows already collected) waits for the next read.
                            const ids = outputCallIds(raw, this.source);
                            if (before === undefined && ids.some(id => this.changes.pending(id))) {
                                held = row.line;
                                entries.length = 0;
                                bytes = 0;
                                cursor = row.line;
                                continue;
                            }
                            const attached = {};
                            for (const id of ids) {
                                const files = await this.changes.changes(id);
                                if (files)
                                    attached[id] = files;
                            }
                            // A row that already carries a worker's own diff (OpenCode edit,
                            // write or patch) keeps it; the shell lookup only fills in the rest.
                            if (Object.keys(attached).length)
                                raw = { ...raw, phren_changes: { ...attached, ...object(raw.phren_changes) } };
                        }
                        const projected = this.source === "codex" ? projectCodexRow(raw) : { rows: [raw] };
                        rows = this.imageLine === row.line ? projected.rows : projected.rows.map(r => chatFrame(r, this.source));
                        if (projected.base)
                            rewriteProjectedOutput(entries, projected.base);
                    }
                }
                catch { /* A malformed old row cannot block the next readable page. */ }
                if (rows.length) {
                    const size = Buffer.byteLength(JSON.stringify(rows));
                    if (this.imageLine !== undefined || size < 2_097_152) {
                        // Leave an entry that doesn't fit for the following history page.
                        if (this.imageLine === undefined && bytes + size > byteBudget)
                            break;
                        // Rows arrive newest first; reverse a row's blocks so the page
                        // lists several calls from one source in the order they were written.
                        entries.push(...rows.slice().reverse().map(raw => ({ line: row.line, raw })));
                        bytes += size;
                    }
                }
                cursor = row.line;
                if (entries.length >= entryBudget)
                    break;
            }
            if (before === undefined) {
                this.revision = index.revision;
                this.nextLine = held ?? index.lines;
            }
            // Live reads run newest first. After a long disconnect or a burst of
            // output, a bounded page can stop before the phone's cursor. Mark that
            // page as a replacement so its start becomes a usable older-page cursor
            // instead of silently merging two disjoint windows. A pending diff
            // holds its row for a later poll and is not a completed page.
            const skippedLiveLines = before === undefined && held === undefined && cursor > lower;
            return { entries: entries.reverse(), totalLines: index.lines, startLine: cursor, hasMore: cursor > 0,
                reset: (resuming && !pastEnd ? false : reset) || skippedLiveLines };
        }, signal);
    }
}
/** One embedded image: block `block` of the row's content — or, with
 * `inner`, image `inner` inside that block's tool_result content (what a
 * Read of a PNG returns). For Codex, an output row's array is the content. */
export async function historicalImage(file, line, block, source, inner) {
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(block) || block < 0 || block > 2000)
        throw new BridgeError(400, "Invalid image reference.");
    if (inner !== undefined && (!Number.isSafeInteger(inner) || inner < 0 || inner > 2000))
        throw new BridgeError(400, "Invalid image reference.");
    const reader = new TranscriptReader(file, source, line);
    const page = await reader.read(line + 1);
    const row = page.entries.find(e => e.line === line)?.raw;
    if (!row)
        throw new BridgeError(404, "This image is no longer in the transcript.");
    const payload = source === "codex" ? object(row.payload) : source === "phren" || source === "opencode" ? object(object(row.data).message) : object(row.message);
    const content = objects(source === "codex" && Array.isArray(payload.output) ? payload.output : payload.content);
    let image = content[block];
    if (inner !== undefined)
        image = objects(image?.content)[inner];
    const encoded = image?.image_url || object(image?.source).data;
    const base64 = typeof encoded === "string" ? encoded.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "") : "";
    if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64) || base64.length > 11_184_812)
        throw new BridgeError(404, "This image is not embedded in the transcript.");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > 8_388_608)
        throw new BridgeError(413, "This image is too large.");
    return bytes;
}
/** Derive optional diff scope from local tool-call rows, never phone commands. */
export async function conversationNamedPaths(file, source, cwd, signal) {
    return withTranscriptIndex(file, async (handle, index) => {
        const paths = new Set();
        for await (const row of index.rows(handle, index.lines, 0, signal)) {
            signal?.throwIfAborted();
            try {
                const raw = row.bytes && visibleEvent(object(JSON.parse(row.bytes.toString())), source);
                if (!raw)
                    continue;
                const payload = object(raw.payload), data = object(raw.data);
                const calls = source === "codex" ? (["function_call", "custom_tool_call"].includes(String(payload.type)) ? [payload] : [])
                    : source === "copilot" ? (raw.type === "tool.execution_start" ? [data] : [])
                        : objects(object(source === "phren" || source === "opencode" ? data.message : raw.message).content).filter(b => b.type === "tool_use");
                for (const call of calls) {
                    if (!SHELL_TOOLS.has(String(call.name ?? call.toolName)))
                        continue;
                    const args = call.arguments ?? call.input;
                    const input = typeof args === "string" ? object(JSON.parse(args)) : object(args);
                    const command = input.command ?? input.cmd;
                    if (typeof command !== "string")
                        continue;
                    const base = [input.workdir, input.cwd, raw.cwd, cwd].find(v => typeof v === "string" && path.isAbsolute(v));
                    for (const named of namedPaths(command))
                        paths.add(named.startsWith("~/") ? path.join(homedir(), named.slice(2)) : path.resolve(base, named));
                }
            }
            catch { /* Malformed or private rows grant no additional scope. */ }
        }
        return [...paths];
    }, signal);
}
