import { readdir, realpath, lstat, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { codexHome } from "../home-paths.js";
import { claudeAccountRef, claudeHomeOfPath, claudeHomes, type AccountRef } from "./claude-accounts.js";
import { paneAccount, paneAccountKey } from "./pane-accounts.js";
import path from "node:path";
import { withTranscriptIndex } from "./transcript-index.js";
import { BridgeError, object, objects, sessionId, type Json, type Provider, type Target } from "./protocol.js";
import { materializeCodexThread, materializedRoot } from "./codex-threads.js";
import { namedPaths, SHELL_TOOLS, outputCallIds, type ChangeLookup } from "./changes.js";
import { fanoutChildren } from "./fanouts.js";
import { claudeChildAgents, claudePromptIdentity, visibleClaudeEvent, type ClaudeQueueState } from "./transcript-claude.js";
import { childTranscriptBelongsTo, codeModeOutputCall, directChildAgents, findCodeModeCall, projectCodeModeOutput, projectCodexRow,
  rewriteProjectedOutput, visibleCodexEvent } from "./transcript-codex.js";
import { visibleCopilotEvent } from "./transcript-copilot.js";
import { visibleOpencodeEvent } from "./transcript-opencode.js";

export { isNarration, unwrapPastedContent } from "./transcript-claude.js";
export { codeToolCalls, projectCodexRow, type CodeToolCall } from "./transcript-codex.js";

export interface Entry { line: number; raw: Json; promptEntryId?: string }
export interface ChildAgentRelation {
  /** `id` is a parent-scoped public reference; local session and transcript details never leave Hook. */
  id: string; session?: string; transcript?: string; provider: Provider; path: string; callId: string; state: "running" | "completed" | "failed" | "gone" | "unavailable";
  /** Why a fan-out worker did not finish: `blocked: <type> <pattern>`. */
  reason?: string;
  /** Present only when a source supplies a validated worker launch time. */
  startedAt?: string;
  finishedAt?: string;
  /** Fan-out manifests and Claude child transcripts can name a model. */
  model?: string;
  fanout?: { resumable: boolean };
  /** Public checkout labels for fan-outs; full paths remain private. */
  worktreeName?: string;
  branch?: string;
  /** The checkout a fan-out worker owns; parent-checkout children omit it. */
  cwd?: string;
  /** Remote rows carry only routing identities, never a local path. */
  computer?: { id: string; name: string };
  remote?: { target: Target; child?: string };
  children: ChildAgentRelation[];
}
export interface LocalChildAgentRelation extends ChildAgentRelation {
  session: string;
  transcript: string;
  remote?: undefined;
}

/** Provider-neutral child-agent discovery. Codex currently supplies explicit
 * SubAgentActivity links; other providers return no children until their
 * public transcript format exposes an equivalent relationship. */
export async function childAgentTree(source: Provider, session: string, depth = 0, seen = new Set<string>(), computer = "local"): Promise<ChildAgentRelation[]> {
  const identity = `${computer}\0${source}\0${session}`;
  if (depth >= 4 || seen.size >= 128 || seen.has(identity)) return [];
  seen.add(identity);
  const fanouts: ChildAgentRelation[] = (await fanoutChildren(source, session, process.env,
    computer === "local" ? undefined : computer)).map(child => ({
    ...child, session: child.session ?? child.id, cwd: child.cwd, children: [],
  }));
  if (!["codex", "claude"].includes(source)) return fanouts;
  const file = await transcriptPath(source, session);
  if (source === "claude") return [...await claudeChildAgents(file, session), ...fanouts];
  const relations = await directChildAgents(file), verified: ChildAgentRelation[] = [];
  for (const relation of relations) {
    const childFile = await transcriptPath(source, relation.session).catch(() => undefined);
    if (!childFile || !await childTranscriptBelongsTo(childFile, session)) continue;
    verified.push({ ...relation, transcript: childFile, provider: source,
      id: createHash("sha256").update(`${source}\0${session}\0${relation.session}`).digest("hex").slice(0, 32),
      children: await childAgentTree(source, relation.session, depth + 1, seen, computer).catch(() => []) });
  }
  return [...verified, ...fanouts];
}

/** Explicit wire projection prevents a provider's private transcript identity
 * from being returned if relation internals grow later. */
export function publicChildAgents(tree: ChildAgentRelation[]): Json[] {
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

export function childAgent(tree: ChildAgentRelation[], id: string): LocalChildAgentRelation | undefined {
  for (const node of tree) {
    if (node.remote !== undefined) continue;
    if (node.id === id && node.session !== undefined && node.transcript !== undefined) return node as LocalChildAgentRelation;
    const nested = childAgent(node.children, id); if (nested) return nested;
  }
}

/** The running children of a child-agent tree, at any depth: the sub-agents,
 * teammates, workflow agents and fan-out jobs a finished turn still waits on. */
export function runningChildAgents(tree: ChildAgentRelation[]): ChildAgentRelation[] {
  return tree.flatMap(function visit(child): ChildAgentRelation[] {
    return [child, ...child.children.flatMap(visit)];
  }).filter(child => child.state === "running");
}

/** Preserve content positions and image types; original bytes stay in the
 * transcript for the separate image route. Only provider content blocks are
 * interpreted, never text strings or arbitrary tool arguments. */
function imageReferences(content: unknown, toolResults = false): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(value => {
    const block = object(value);
    if (["image", "input_image"].includes(String(block.type))) return { type: block.type };
    if (toolResults && block.type === "tool_result") return { ...block, content: toolOutputReferences(block.content) };
    return value;
  });
}

function toolOutputReferences(output: unknown): unknown {
  if (Array.isArray(output)) return imageReferences(output);
  const result = object(output);
  return Array.isArray(result.content) ? { ...result, content: imageReferences(result.content) } : output;
}

/**
 * The phren store whose `.sessions` holds phren-agent event logs (and
 * `.runtime/sessions` OpenCode's plugin logs).
 * `PHREN_PATH` or the shared `~/.phren` root — the two resolutions the CLI's
 * `findPhrenPath` makes without a working directory, which a service has none
 * of. Kept inline rather than importing phren-paths: that module drags in
 * yaml and the data layer, and this bundle is budgeted for cold start.
 */
export function phrenStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PHREN_PATH?.trim();
  if (!configured) return path.join(homedir(), ".phren");
  const expanded = configured === "~" ? homedir() : configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : configured;
  return path.resolve(expanded);
}

function chatFrame(raw: Json, source: Provider): Json {
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
function segmentRegExp(segment: string): RegExp {
  const source = segment.split(/([*?])/).map(part => {
    if (part === "*") return "[^/]*";
    if (part === "?") return "[^/]";
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return new RegExp(`^${source}$`);
}

/** The fixed transcript layouts globbed for: `*` within a single segment, no
 * `**`, dotfiles skipped, symlinked directories not followed. Kept native so
 * the Hook bundle does not carry the `glob` package. */
async function findPatternMatches(root: string, pattern: string): Promise<string[]> {
  const segments = pattern.split("/");
  const expressions = segments.map(segmentRegExp);
  const matches: string[] = [];
  const walk = async (dir: string, index: number): Promise<void> => {
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (!segment.includes("*") && !segment.includes("?")) {
      const next = path.join(dir, segment);
      try {
        const info = await lstat(next);
        if (last) {
          // glob returns a symlink to a file here too; the caller's realpath
          // check is what rejects one pointing outside the provider folder.
          if (info.isFile() || info.isSymbolicLink()) matches.push(next);
        } else if (info.isDirectory()) {
          await walk(next, index + 1);
        }
      } catch { /* no match */ }
      return;
    }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !expressions[index].test(entry.name)) continue;
      const next = path.join(dir, entry.name);
      if (last) {
        if (entry.isFile() || entry.isSymbolicLink()) matches.push(next);
      } else if (entry.isDirectory()) {
        await walk(next, index + 1);
      }
    }
  };
  await walk(root, 0);
  return matches;
}

/** The account a resolved Claude transcript belongs to, by the home holding it. */
export function transcriptAccount(file: string): AccountRef | undefined {
  const home = claudeHomeOfPath(file);
  return home ? claudeAccountRef(home) : undefined;
}

/** A pane's transcript: the pane's known Claude account settles a session id found in more than one home. */
export function targetTranscriptPath(target: { server: string; pane: string; source: Provider; session: string }): Promise<string> {
  const account = target.source === "claude" ? paneAccount(paneAccountKey(target.server, target.pane))?.id : undefined;
  return transcriptPath(target.source, target.session, account);
}

/** Shared ambiguity rule for chat reads and the search index. A session ID
 * alone cannot select between Claude account copies. Codex's caller falls
 * back to its materialized store when no unique rollout can be chosen. */
export function selectTranscriptMatch<T extends { id?: string | undefined }>(source: Provider, found: T[], account?: string): T | undefined {
  let chosen = found;
  if (source === "claude" && found.length > 1 && account) {
    const preferred = found.filter(item => item.id === account);
    if (preferred.length) chosen = preferred;
  }
  return chosen.length === 1 ? chosen[0] : undefined;
}

/** `account` (a Claude home id) settles a session id found in more than one home. */
export async function transcriptPath(source: Provider, session: string, account?: string): Promise<string> {
  if (!sessionId.safeParse(session).success) throw new BridgeError(400, "Invalid conversation identity.");
  const bases: { id?: string; base: string }[] = source === "codex" ? [{ base: path.join(codexHome(), "sessions") }]
    : source === "claude" ? claudeHomes().map(home => ({ id: home.id, base: path.join(home.dir, "projects") }))
    // phren-agent keeps its event logs in the store's `.sessions` (the CLI's
    // sessionsDir); OpenCode's plugin writes under `.runtime/sessions`.
    : source === "phren" ? [{ base: path.join(phrenStoreRoot(), ".sessions") }, { base: path.join(phrenStoreRoot(), ".runtime", "sessions") }]
    : source === "opencode" ? [{ base: path.join(phrenStoreRoot(), ".runtime", "sessions") }]
    : [{ base: path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "session-state") }];
  const pattern = source === "codex" ? `*/*/*/rollout-*-${session}.jsonl` : source === "claude" ? `*/${session}.jsonl`
    : source === "phren" ? `session-${session}.events.jsonl` : source === "opencode" ? `opencode-${session}.events.jsonl` : `${session}/events.jsonl`;
  const found: { id?: string; root: string; match: string }[] = [];
  for (const entry of bases) {
    const root = await realpath(entry.base).catch(() => entry.base);
    const matches = await findPatternMatches(root, pattern).catch(() => [] as string[]);
    for (const match of matches) found.push({ id: entry.id, root, match });
  }
  const chosen = selectTranscriptMatch(source, found, account);
  if (!chosen) {
    // Codex 0.155 keeps new threads only in its sqlite store; the Hook
    // materializes those into a rollout-shaped file of its own.
    const materialized = source === "codex" ? await materializeCodexThread(session) : undefined;
    if (materialized) return materialized;
    throw new BridgeError(404, "The transcript is not available for this conversation.", { code: "transcript-unavailable" });
  }
  const file = await realpath(chosen.match);
  if (!file.startsWith(chosen.root + path.sep)) throw new BridgeError(403, "The transcript points outside its agent folder.");
  return file;
}

/** Keeps a materialized Codex thread current before a read; a no-op for
 * transcripts the agent writes itself. */
export async function refreshTranscript(file: string, source: Provider, session: string): Promise<void> {
  if (source === "codex" && file.startsWith(materializedRoot() + path.sep)) await materializeCodexThread(session);
}

/** Public conversation/tool events and real usage only. Never export private reasoning. */
export function visibleEvent(raw: Json, source: Provider, includeSidechain = false, cwd?: string, queue?: ClaudeQueueState): Json | undefined {
  if (source === "phren" || source === "opencode") return visibleOpencodeEvent(raw, source, cwd);
  if (source === "codex") return visibleCodexEvent(raw);
  if (source === "claude") return visibleClaudeEvent(raw, includeSidechain, queue);
  return visibleCopilotEvent(raw);
}

/** Apply the code-mode wrapper projection used by both stream pages and
 * completion lookup. Covered script status rows never become public entries. */
async function projectTranscriptEvent(raw: Json | undefined, source: Provider, line: number,
  rows: (before: number, after: number) => AsyncIterable<{ line: number; bytes?: Buffer }>): Promise<Json | undefined> {
  const call = raw && source === "codex" ? codeModeOutputCall(raw) : undefined;
  return raw && call ? projectCodeModeOutput(raw, await findCodeModeCall(rows, line, call)) : raw;
}

function projectTranscriptRows(raw: Json, source: Provider): { rows: Json[]; base?: string } {
  return source === "codex" ? projectCodexRow(raw) : { rows: [raw] };
}

/** Prompt ids seen on eligible user rows across the whole conversation, kept
 * per file revision and extended by appends so every page and reader applies
 * the same ambiguity rule. */
const promptIdentityCounts = new Map<string, { revision: string; lines: number; counts: Map<string, number> }>();

export async function ambiguousPromptIdentities(file: string, handle: FileHandle,
  index: { revision: string; lines: number; rows: (handle: FileHandle, before: number, after: number, signal?: AbortSignal) => AsyncIterable<{ line: number; bytes?: Buffer }> },
  source: Provider, includeSidechain: boolean, signal?: AbortSignal): Promise<Set<string>> {
  if (source !== "claude") return new Set();
  const key = `${file}\0${source}\0${includeSidechain ? 1 : 0}`;
  const current = promptIdentityCounts.get(key);
  const reset = !current || current.revision !== index.revision || current.lines > index.lines;
  const ambiguous = (counts: Map<string, number>) => {
    const ids = new Set<string>();
    for (const [id, count] of counts) if (count > 1) ids.add(id);
    return ids;
  };
  if (!reset && current && current.lines === index.lines) return ambiguous(current.counts);
  // Work on a private copy. Nothing is published until the whole scan succeeds,
  // so an aborted or failed read leaves the previous counts and position intact.
  const counts = new Map<string, number>(reset || !current ? [] : current.counts), start = reset || !current ? 0 : current.lines;
  if (start < index.lines) {
    const queue: ClaudeQueueState = {};
    for await (const row of index.rows(handle, index.lines, start, signal)) {
      signal?.throwIfAborted();
      if (!row.bytes) continue;
      try {
        const original = object(JSON.parse(row.bytes.toString()));
        const id = claudePromptIdentity(original, visibleClaudeEvent(original, includeSidechain, queue));
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      } catch { /* A malformed row cannot make another prompt ambiguous. */ }
    }
  }
  promptIdentityCounts.delete(key);
  promptIdentityCounts.set(key, { revision: index.revision, lines: index.lines, counts });
  while (promptIdentityCounts.size > 64) promptIdentityCounts.delete(promptIdentityCounts.keys().next().value!);
  return ambiguous(counts);
}

const completionEntries = new Map<string, { signature: string; entry?: string }>();

/** A finished turn's last public row, using the same absolute line key as
 * stream frames and history pages. Reuse their incremental byte index and
 * inspect at most 256 recent rows / 1 MiB, never scan the full history for a
 * completion. Missing timestamps or an unresolved tail leave it manual. */
export async function completionEntry(file: string, source: Provider, promptAt: string, stopAt: string, finalReply?: { reply?: string; truncated?: boolean }): Promise<string | undefined> {
  const since = Date.parse(promptAt), until = Date.parse(stopAt);
  if (!Number.isFinite(since) || !Number.isFinite(until) || until < since || (source === "claude" && finalReply?.truncated)) return undefined;
  return withTranscriptIndex(file, async (handle, index) => {
    const key = `${file}\0${source}`, signature = JSON.stringify([index.revision, index.lines, promptAt, stopAt, finalReply?.reply, finalReply?.truncated]);
    const cached = completionEntries.get(key);
    if (cached?.signature === signature) return cached.entry;
    let entry: string | undefined, bytes = 0;
    for await (const row of index.rows(handle, index.lines, Math.max(0, index.lines - 256))) {
      if (!row.bytes || (bytes += row.bytes.length) > 1_048_576) break;
      try {
        const raw = await projectTranscriptEvent(visibleEvent(object(JSON.parse(row.bytes.toString())), source), source, row.line,
          (before, after) => index.rows(handle, before, after));
        if (!raw || raw.isSidechain === true) continue;
        const projected = projectTranscriptRows(raw, source).rows.map(value => chatFrame(value, source));
        if (!projected.length || Buffer.byteLength(JSON.stringify(projected)) >= 2_097_152) continue;
        // Progress can repeat the final reply verbatim. Require terminal
        // evidence even when the text matches the Stop's complete reply.
        if (source === "claude") {
          if (raw.type !== "assistant") continue;
          const message = object(raw.message), content = message.content;
          if (message.stop_reason !== "end_turn") continue;
          const blocks = objects(content);
          if (!(typeof content === "string" ? content.trim() : blocks.some(block =>
            ["text", "image", "tool_use", "tool_result"].includes(String(block.type))))) continue;
          const text = typeof content === "string" ? content.trim()
            : blocks.filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n").trim();
          if (finalReply?.reply && text) {
            if (text !== finalReply.reply.trim()) continue;
          }
        }
        const stamp = raw.timestamp ?? raw.time;
        const at = typeof stamp === "string" ? Date.parse(stamp) : NaN;
        // An undated candidate could be the final row: falling back to an
        // earlier answer would let the phone mark an unseen reply seen.
        if (!Number.isFinite(at)) break;
        if (at < since || at > until) continue;
        entry = String(row.line);
        break;
      } catch { /* Malformed rows do not identify a completion. */ }
    }
    completionEntries.delete(key);
    completionEntries.set(key, { signature, entry });
    while (completionEntries.size > 128) completionEntries.delete(completionEntries.keys().next().value!);
    return entry;
  });
}

/** Parse only the requested page; shared byte indexes make reopening and
 * backward pagination independent of the amount of already-read history. */
export class TranscriptReader {
  private revision?: string;
  private nextLine = 0;
  private ambiguous = new Set<string>();
  constructor(readonly file: string, readonly source: Provider, private readonly imageLine?: number, private readonly changes?: ChangeLookup,
              private readonly includeSidechain = false, private readonly cwd?: string,
              /** The phone delivery bound to each Claude queue row, by byte offset (PromptDeliveries). */
              private readonly queueBindings?: () => Promise<Map<number, string> | undefined>) {}
  /** Prompt ids the latest page found ambiguous across the conversation. */
  get ambiguousPromptIds(): ReadonlySet<string> { return this.ambiguous; }
  /** A fresh opening page with the same reader options, for a reset after an
   * identity already delivered by this stream became ambiguous. */
  snapshot(signal?: AbortSignal): Promise<{ entries: Entry[]; totalLines: number; startLine: number; hasMore: boolean; reset: boolean }> {
    return new TranscriptReader(this.file, this.source, this.imageLine, this.changes, this.includeSidechain, this.cwd, this.queueBindings).read(undefined, signal);
  }
  async read(before?: number, signal?: AbortSignal): Promise<{ entries: Entry[]; totalLines: number; startLine: number; hasMore: boolean; reset: boolean }> {
    return this.readPage(before, undefined, signal);
  }
  /** Resume a fresh live reader after the last raw line the client retained. */
  async readAfter(afterLine: number, signal?: AbortSignal): Promise<{ entries: Entry[]; totalLines: number; startLine: number; hasMore: boolean; reset: boolean }> {
    if (!Number.isSafeInteger(afterLine) || afterLine < 0) throw new BridgeError(400, "Invalid transcript cursor.");
    return this.readPage(undefined, afterLine, signal);
  }
  private async readPage(before?: number, afterLine?: number, signal?: AbortSignal): Promise<{ entries: Entry[]; totalLines: number; startLine: number; hasMore: boolean; reset: boolean }> {
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
      const entries: Entry[] = [];
      // The first page of a conversation is what the phone parses and lays
      // out before anything shows; keep it light and let scrolling fetch the
      // rest in fuller pages. A live tail (nextLine known) stays small too.
      const opening = before === undefined && (pastEnd || (!resuming && (reset || this.nextLine === 0)));
      const entryBudget = opening ? 60 : 200;
      const byteBudget = opening ? 1_048_576 : 4_194_304;
      let bytes = 0, cursor = end, held: number | undefined;
      // Claude's queue pairing: the row scan is newest-first, so a prompt turn
      // is seen before the content-free dequeue that delivered it. The bindings
      // name the phone message behind each queue occurrence when the Hook has
      // tracked the send, so the queue row and its consumption share one id.
      const bindings = this.imageLine === undefined && this.source === "claude" && this.queueBindings
        ? await this.queueBindings().catch(() => undefined) : undefined;
      const queue: ClaudeQueueState = bindings
        ? { deliveryFor: (_raw, offset) => offset === undefined ? undefined : bindings.get(offset) } : {};
      for await (const row of index.rows(handle, end, lower, signal)) {
        signal?.throwIfAborted();
        queue.offset = row.offset;
        let rows: Json[] = [];
        let promptEntryId: string | undefined;
        try {
          // Read the native identity from the original row before visibility
          // filtering removes harness metadata from the projected entry.
          const original = row.bytes ? object(JSON.parse(row.bytes.toString())) : undefined;
          let raw = original && visibleEvent(original, this.source, this.includeSidechain, this.cwd, queue);
          // A child agent's transcript is the sidechain. Its rows are that
          // conversation's own turns, not something for the reader to skip.
          if (raw && this.includeSidechain && raw.isSidechain === true) { const { isSidechain: _sidechain, ...own } = raw; raw = own; }
          // A code-mode script's result follows from the script it answers,
          // a few rows earlier: hidden when its items carry the actions.
          raw = await projectTranscriptEvent(raw, this.source, row.line,
            (upper, lower) => index.rows(handle, upper, lower, signal));
          if (raw) {
            if (this.changes && this.imageLine === undefined) {
              // A shell call's output carries what it changed on disk. While
              // that diff is still being computed on the live tail, the row
              // (and the newer rows already collected) waits for the next read.
              const ids = outputCallIds(raw, this.source);
              if (before === undefined && ids.some(id => this.changes!.pending(id))) { held = row.line; entries.length = 0; bytes = 0; cursor = row.line; continue; }
              const attached: Json = {};
              const failures: Json = {};
              for (const id of ids) {
                try { const files = await this.changes.changes(id); if (files) attached[id] = files; }
                catch (error) {
                  // Keep the tool output visible; the outer malformed-row guard
                  // must never hide it just because Git could not collect changes.
                  failures[id] = { error: error instanceof BridgeError ? error.message : "Git change capture failed.",
                    code: error instanceof BridgeError ? error.details?.code ?? "git-capture-failed" : "git-capture-failed" };
                }
              }
              if (Object.keys(failures).length) raw = { ...raw, phren_change_errors: failures };
              // A row that already carries a worker's own diff (OpenCode edit,
              // write or patch) keeps it; the shell lookup only fills in the rest.
              if (Object.keys(attached).length) raw = { ...raw, phren_changes: { ...attached, ...object(raw.phren_changes) } };
            }
            const projected = projectTranscriptRows(raw, this.source);
            rows = this.imageLine === row.line ? projected.rows : projected.rows.map(r => chatFrame(r, this.source));
            if (projected.base) rewriteProjectedOutput(entries, projected.base);
            if (this.source === "claude" && original) promptEntryId = claudePromptIdentity(original, raw);
          }
        } catch { /* A malformed old row cannot block the next readable page. */ }
        if (rows.length) {
          const size = Buffer.byteLength(JSON.stringify(rows));
          if (this.imageLine !== undefined || size < 2_097_152) {
            // Leave an entry that doesn't fit for the following history page.
            if (this.imageLine === undefined && bytes + size > byteBudget) break;
            // Rows arrive newest first; reverse a row's blocks so the page
            // lists several calls from one source in the order they were written.
            entries.push(...rows.slice().reverse().map(raw => ({ line: row.line, raw, ...(promptEntryId ? { promptEntryId } : {}) })));
            bytes += size;
          }
        }
        cursor = row.line;
        if (entries.length >= entryBudget) break;
      }
      // Live reads run newest first. After a long disconnect or a burst of
      // output, a bounded page can stop before the phone's cursor. Mark that
      // page as a replacement so its start becomes a usable older-page cursor
      // instead of silently merging two disjoint windows. A pending diff
      // holds its row for a later poll and is not a completed page.
      const skippedLiveLines = before === undefined && held === undefined && cursor > lower;
      // One prompt identity on several displayed prompts is ambiguous, so
      // none of them may claim it, whichever page or reader sees it.
      // A cursor resume must also invalidate identities retained by the phone,
      // even when the resumed page contains no prompt rows at all.
      if (resuming || entries.some(entry => entry.promptEntryId)) {
        this.ambiguous = await ambiguousPromptIdentities(this.file, handle, index, this.source, this.includeSidechain, signal);
        for (const entry of entries) if (entry.promptEntryId && this.ambiguous.has(entry.promptEntryId)) delete entry.promptEntryId;
      } else if (reset) this.ambiguous.clear();
      // Only a completed read (including the fallible identity scan) advances
      // the live cursor, so a retry rereads the same rows.
      if (before === undefined) { this.revision = index.revision; this.nextLine = held ?? index.lines; }
      // The phone resumes after `totalLines - 1`, so a live page does not
      // count a held row or what follows it: those are still owed. An older
      // page is never a replacement. The history route reads with a fresh
      // reader, and a reset there made the phone drop every recent row it
      // held and keep only the older page.
      return { entries: entries.reverse(), totalLines: held ?? index.lines,
        startLine: cursor, hasMore: cursor > 0,
        reset: before !== undefined ? false : (resuming && !pastEnd ? false : reset) || skippedLiveLines };
    }, signal);
  }
}

/** One embedded image: block `block` of the row's content — or, with
 * `inner`, image `inner` inside that block's tool_result content (what a
 * Read of a PNG returns). For Codex, an output row's array is the content. */
export async function historicalImage(file: string, line: number, block: number, source: Provider, inner?: number): Promise<Buffer> {
  if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(block) || block < 0 || block > 2000) throw new BridgeError(400, "Invalid image reference.");
  if (inner !== undefined && (!Number.isSafeInteger(inner) || inner < 0 || inner > 2000)) throw new BridgeError(400, "Invalid image reference.");
  const reader = new TranscriptReader(file, source, line);
  const page = await reader.read(line + 1);
  const row = page.entries.find(e => e.line === line)?.raw;
  if (!row) throw new BridgeError(404, "This image is no longer in the transcript.");
  const payload = source === "codex" ? object(row.payload) : source === "phren" || source === "opencode" ? object(object(row.data).message) : object(row.message);
  const content = objects(source === "codex" && Array.isArray(payload.output) ? payload.output : payload.content);
  let image = content[block];
  if (inner !== undefined) image = objects(image?.content)[inner];
  const encoded = image?.image_url || object(image?.source).data;
  const base64 = typeof encoded === "string" ? encoded.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "") : "";
  if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64) || base64.length > 11_184_812) throw new BridgeError(404, "This image is not embedded in the transcript.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > 8_388_608) throw new BridgeError(413, "This image is too large.");
  return bytes;
}

/** Derive optional diff scope from local tool-call rows, never phone commands. */
export async function conversationNamedPaths(file: string, source: Provider, cwd: string, signal?: AbortSignal): Promise<string[]> {
  return withTranscriptIndex(file, async (handle, index) => {
    const paths = new Set<string>();
    for await (const row of index.rows(handle, index.lines, 0, signal)) {
      signal?.throwIfAborted();
      try {
        const raw = row.bytes && visibleEvent(object(JSON.parse(row.bytes.toString())), source);
        if (!raw) continue;
        const payload = object(raw.payload), data = object(raw.data);
        const calls = source === "codex" ? (["function_call", "custom_tool_call"].includes(String(payload.type)) ? [payload] : [])
          : source === "copilot" ? (raw.type === "tool.execution_start" ? [data] : [])
          : objects(object(source === "phren" || source === "opencode" ? data.message : raw.message).content).filter(b => b.type === "tool_use");
        for (const call of calls) {
          if (!SHELL_TOOLS.has(String(call.name ?? call.toolName))) continue;
          const args = call.arguments ?? call.input;
          const input = typeof args === "string" ? object(JSON.parse(args)) : object(args);
          const command = input.command ?? input.cmd;
          if (typeof command !== "string") continue;
          const base = [input.workdir, input.cwd, raw.cwd, cwd].find(v => typeof v === "string" && path.isAbsolute(v)) as string;
          for (const named of namedPaths(command)) paths.add(named.startsWith("~/") ? path.join(homedir(), named.slice(2)) : path.resolve(base, named));
        }
      } catch { /* Malformed or private rows grant no additional scope. */ }
    }
    return [...paths];
  }, signal);
}
