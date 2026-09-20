import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "glob";
import { withTranscriptIndex } from "./transcript-index.js";
import { BridgeError, object, objects, sessionId, type Json, type Provider } from "./protocol.js";
import { namedPaths, SHELL_TOOLS, outputCallIds, type ChangeLookup } from "./changes.js";
import { fanoutChildren, visibleCodexExecEvent, visibleOpenCodeRunEvent } from "./fanouts.js";

export interface Entry { line: number; raw: Json }
export interface ChildAgentRelation {
  /** `id` is a parent-scoped public reference; `session` never leaves Hook. */
  id: string; session: string; transcript: string; provider: Provider; path: string; callId: string; state: "running" | "completed";
  /** Only fan-out manifests name a model; other providers leave it absent. */
  model?: string;
  /** The checkout a fan-out worker owns; parent-checkout children omit it. */
  cwd?: string;
  children: ChildAgentRelation[];
}
type DirectRelation = Omit<ChildAgentRelation, "id" | "transcript" | "provider" | "children">;
type ChildRelationCache = {
  dev: number; ino: number; fileSize: number; completeOffset: number; mtimeMs: number;
  relations: Map<string, DirectRelation>;
};
const childRelationCache = new Map<string, ChildRelationCache>();

function addChildRelation(line: string, found: Map<string, DirectRelation>): void {
  if (!line.includes("SubAgentActivity")) return;
  try {
    const raw = object(JSON.parse(line)), payload = object(raw.payload), item = object(payload.item);
    if (raw.type !== "event_msg" || payload.type !== "item_completed" || item.type !== "SubAgentActivity") return;
    const kind = String(item.kind), child = String(item.agent_thread_id ?? ""), agentPath = String(item.agent_path ?? "");
    const callId = String(item.id ?? "");
    if (!["started", "completed"].includes(kind) || !sessionId.safeParse(child).success || !callId || agentPath.length > 512) return;
    const previous = found.get(child);
    found.set(child, { session: child, path: agentPath, callId: previous?.callId || callId,
      state: kind === "completed" ? "completed" : previous?.state ?? "running" });
  } catch { /* Ignore malformed/private rows. */ }
}

async function directChildAgents(file: string): Promise<DirectRelation[]> {
  const metadata = await stat(file), cached = childRelationCache.get(file);
  if (cached && cached.dev === metadata.dev && cached.ino === metadata.ino
      && cached.fileSize === metadata.size && cached.mtimeMs === metadata.mtimeMs) return [...cached.relations.values()];
  // Codex rollouts are append-only. Keep the byte position of the last full
  // JSONL row so a live transcript only scans new rows as its chat advances.
  // A truncate, replacement, or in-place rewrite starts from zero.
  const append = cached && cached.dev === metadata.dev && cached.ino === metadata.ino && metadata.size > cached.fileSize;
  const start = append ? cached.completeOffset : 0;
  const found = append ? new Map(cached.relations) : new Map<string, DirectRelation>();
  let pending = Buffer.alloc(0), completeOffset = start;
  const input = metadata.size > start ? createReadStream(file, { start, end: metadata.size - 1 }) : undefined;
  for await (const chunk of input ?? []) {
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      addChildRelation(pending.subarray(0, newline).toString("utf8"), found);
      completeOffset += newline + 1; pending = pending.subarray(newline + 1);
    }
  }
  const entry = { dev: metadata.dev, ino: metadata.ino, fileSize: metadata.size, completeOffset,
    mtimeMs: metadata.mtimeMs, relations: found };
  childRelationCache.set(file, entry);
  while (childRelationCache.size > 64) childRelationCache.delete(childRelationCache.keys().next().value!);
  return [...found.values()];
}

/** Provider-neutral child-agent discovery. Codex currently supplies explicit
 * SubAgentActivity links; other providers return no children until their
 * public transcript format exposes an equivalent relationship. */
export async function childAgentTree(source: Provider, session: string, depth = 0, seen = new Set<string>()): Promise<ChildAgentRelation[]> {
  if (depth >= 4 || seen.size >= 128 || seen.has(session)) return [];
  seen.add(session);
  const fanouts: ChildAgentRelation[] = (await fanoutChildren(source, session)).map(child => ({
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
      children: await childAgentTree(source, relation.session, depth + 1, seen).catch(() => []) });
  }
  return [...verified, ...fanouts];
}

const claudeRelationCache = new Map<string, { signature: string; relations: ChildAgentRelation[]; recheckAt?: number }>();
async function claudeChildAgents(file: string, session: string): Promise<ChildAgentRelation[]> {
  const metadata = await stat(file), signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  const cached = claudeRelationCache.get(file);
  if (cached?.signature === signature && !(cached.recheckAt !== undefined && Date.now() >= cached.recheckAt)) return cached.relations;
  const launches = new Map<string, { path: string; callId: string; state: "running" | "completed" }>();
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const raw = object(JSON.parse(line)), result = object(raw.toolUseResult);
      const agentId = String(result.agentId ?? ""), status = String(result.status ?? "");
      if (/^[A-Za-z0-9._-]{1,128}$/.test(agentId) && ["async_launched", "running"].includes(status)) {
        const blocks = objects(object(raw.message).content), callId = String(blocks.find(b => b.type === "tool_result")?.tool_use_id ?? "");
        if (callId) launches.set(agentId, { path: String(result.description || result.name || "Agent").slice(0, 200), callId, state: "running" });
      }
      const content = typeof raw.content === "string" ? raw.content : typeof object(raw.message).content === "string" ? String(object(raw.message).content) : "";
      if (content.includes("<task-notification>")) {
        const child = /<task-id>([^<>]{1,128})<\/task-id>/.exec(content)?.[1], taskStatus = /<status>([^<>]+)<\/status>/.exec(content)?.[1];
        const previous = child && launches.get(child); if (previous && ["completed", "failed", "cancelled"].includes(taskStatus ?? "")) previous.state = "completed";
      }
    } catch { /* Ignore unrelated/malformed rows. */ }
  }
  const relations: ChildAgentRelation[] = [];
  // Claude Code records the launch in the parent before the child's own
  // file exists. A launch without a transcript yet is looked for again
  // shortly, rather than being missed until the parent next changes.
  let awaiting = false;
  const root = await realpath(path.join(path.dirname(file), session, "subagents")).catch(() => undefined);
  for (const [agentId, launch] of launches) {
    const childFile = root && await realpath(path.join(root, `agent-${agentId}.jsonl`)).catch(() => undefined);
    if (!childFile || !childFile.startsWith(root + path.sep) || !await claudeChildBelongsTo(childFile, session, agentId)) {
      if (launch.state === "running") awaiting = true;
      continue;
    }
    relations.push({ id: createHash("sha256").update(`claude\0${session}\0${agentId}`).digest("hex").slice(0, 32),
      session: agentId, transcript: childFile, provider: "claude", ...launch, children: [] });
  }
  claudeRelationCache.set(file, { signature, relations, ...(awaiting ? { recheckAt: Date.now() + 2_000 } : {}) });
  while (claudeRelationCache.size > 64) claudeRelationCache.delete(claudeRelationCache.keys().next().value!);
  return relations;
}

async function claudeChildBelongsTo(file: string, parent: string, agentId: string): Promise<boolean> {
  let bytes = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { start: 0, end: 1_048_575 })) {
    bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const newline = bytes.indexOf(0x0a); if (newline >= 0) { bytes = bytes.subarray(0, newline); break; }
  }
  try {
    const raw = object(JSON.parse(bytes.toString("utf8")));
    return (raw.isSidechain === true && raw.sessionId === parent && raw.agentId === agentId)
      || (raw.type === "fork-context-ref" && raw.parentSessionId === parent && raw.agentId === agentId);
  } catch { return false; }
}

async function childTranscriptBelongsTo(file: string, parent: string): Promise<boolean> {
  let bytes = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { start: 0, end: 1_048_575 })) {
    bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const newline = bytes.indexOf(0x0a); if (newline >= 0) { bytes = bytes.subarray(0, newline); break; }
  }
  try {
    const raw = object(JSON.parse(bytes.toString("utf8"))), payload = object(raw.payload), source = object(payload.source);
    const subagent = object(source.subagent), spawn = object(subagent.thread_spawn);
    return raw.type === "session_meta" && String(spawn.parent_thread_id ?? payload.parent_thread_id ?? "") === parent;
  } catch { return false; }
}

/** Explicit wire projection prevents a provider's private transcript identity
 * from being returned if relation internals grow later. */
export function publicChildAgents(tree: ChildAgentRelation[]): Json[] {
  return tree.map(({ id, provider, path: agentPath, callId, state, model, children }) =>
    ({ id, provider, path: agentPath, callId, state, ...(model !== undefined ? { model } : {}), children: publicChildAgents(children) }));
}

export function childAgent(tree: ChildAgentRelation[], id: string): ChildAgentRelation | undefined {
  for (const node of tree) { if (node.id === id) return node; const nested = childAgent(node.children, id); if (nested) return nested; }
}

const CLAUDE_KEYS = new Set(["type", "uuid", "parentUuid", "timestamp", "message", "gitBranch", "cwd", "requestId", "isMeta", "isSidechain", "isCompactSummary", "phrenQueued", "phrenQueueKey", "phrenBackground"]);
const harnessPreamble = (text: string) => /^<(?:environment_context>|user_instructions>|permission_profile|system-reminder>|turn_context>)/.test(text.trimStart());

function taskNotification(content: string): string | undefined {
  const envelope = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(content)?.[1];
  if (!envelope) return;
  // Only plain tag values are public. Never copy nested output envelopes.
  const values = new Map<string, string>();
  for (const match of envelope.matchAll(/<([a-z-]+)(?:\s[^<>]*)?>([\s\S]*?)<\/\1>/g)) {
    if (["task-id", "tool-use-id", "status", "summary"].includes(match[1]) && !match[2].includes("<") && !values.has(match[1])) values.set(match[1], match[2]);
  }
  const tags = ["task-id", "tool-use-id", "status", "summary"].flatMap(tag => {
    const value = values.get(tag);
    return value === undefined ? [] : [`<${tag}>${value.slice(0, tag === "summary" ? 500 : 200)}</${tag}>`];
  });
  return tags.some(tag => tag.startsWith("<tool-use-id>")) ? `<task-notification>\n${tags.join("\n")}\n</task-notification>` : undefined;
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
 * The phren store whose `.runtime/sessions` holds phren-agent event logs.
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
export async function transcriptPath(source: Provider, session: string): Promise<string> {
  if (!sessionId.safeParse(session).success) throw new BridgeError(400, "Invalid conversation identity.");
  const base = source === "codex" ? path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions")
    : source === "claude" ? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects")
    : source === "phren" || source === "opencode" ? path.join(phrenStoreRoot(), ".runtime", "sessions")
    : path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "session-state");
  const root = await realpath(base);
  const pattern = source === "codex" ? `*/*/*/rollout-*-${session}.jsonl` : source === "claude" ? `*/${session}.jsonl`
    : source === "phren" ? `session-${session}.events.jsonl` : source === "opencode" ? `opencode-${session}.events.jsonl` : `${session}/events.jsonl`;
  const matches = await glob(pattern, { cwd: root, absolute: true, follow: false });
  if (matches.length !== 1) throw new BridgeError(404, "The transcript is not available for this conversation.");
  const file = await realpath(matches[0]);
  if (!file.startsWith(root + path.sep)) throw new BridgeError(403, "The transcript points outside its agent folder.");
  return file;
}

/** Claude Code files bracketed-paste input — which is how Herdr's
 * `agent.prompt` delivers every message the phone sends — as
 * `<pasted_content id="…">…</pasted_content id="…">`. The wrapper is the
 * terminal's bookkeeping, not what the user wrote. */
const PASTED_CONTENT = /<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g;
export function unwrapPastedContent(text: string): string {
  return text.includes("<pasted_content") ? text.replace(PASTED_CONTENT, "$1").trim() : text;
}
function unwrapUserText(message: Json): Json {
  if (message.role !== "user") return message;
  if (typeof message.content === "string") return { ...message, content: unwrapPastedContent(message.content) };
  if (!Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map(block => {
    const b = object(block);
    return b.type === "text" && typeof b.text === "string" ? { ...b, text: unwrapPastedContent(b.text) } : block;
  }) };
}

/** Public conversation/tool events and real usage only. Never export private reasoning. */
export function visibleEvent(raw: Json, source: Provider, includeSidechain = false): Json | undefined {
  if (source === "opencode") {
    const runEvent = visibleOpenCodeRunEvent(raw); if (runEvent) return runEvent;
  }
  if (source === "phren" || source === "opencode") {
    // phren-agent's event log (experimental/agent/src/session/log.ts): the
    // header and log/replace splices are bookkeeping; the three message
    // events are the conversation. Reasoning blocks stay on the computer.
    if (!["user/message", "assistant/message", "tool/results"].includes(String(raw.type))) return undefined;
    const data = object(raw.data), message = object(data.message);
    const content = Array.isArray(message.content)
      ? objects(message.content).map(b => ["text", "image", "tool_use", "tool_result"].includes(String(b.type)) ? b : { type: "redacted" })
      : message.content;
    const exported: Json = { message: { role: message.role, content } };
    for (const key of ["source", "turn", "stop_reason", "usage"]) if (data[key] !== undefined) exported[key] = data[key];
    return { seq: raw.seq, time: raw.time, type: raw.type, data: exported };
  }
  if (source === "codex") {
    const execEvent = visibleCodexExecEvent(raw); if (execEvent) return execEvent;
    const p = object(raw.payload);
    // The model answering this turn is the only field of turn_context the
    // phone shows; its policies and instructions stay on the computer.
    if (raw.type === "turn_context") return typeof p.model === "string" ? { type: "turn_context", timestamp: raw.timestamp, payload: { model: p.model } } : undefined;
    if (raw.type === "event_msg" && p.type === "error") return { type: raw.type, timestamp: raw.timestamp,
      payload: { type: "error", ...(typeof p.message === "string" ? { message: p.message } : {}) } };
    if (raw.type === "event_msg" && ["token_count", "task_started", "task_complete", "task_completed", "turn_aborted", "task_aborted", "error"].includes(String(p.type))) return raw;
    if (raw.type !== "response_item") return undefined;
    if (p.type === "message" && ["user", "assistant"].includes(String(p.role)) && p.channel !== "analysis") {
      const text = typeof p.content === "string" ? p.content : objects(p.content).map(b => typeof b.text === "string" ? b.text : "").join("\n");
      return p.role === "user" && harnessPreamble(text) ? undefined : raw;
    }
    if (["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(String(p.type))) return raw;
  } else if (source === "claude") {
    // A queued phone message carries the same wrapper; unwrap before the
    // digest so enqueue and remove keep matching keys.
    if (raw.type === "queue-operation" && typeof raw.content === "string") raw = { ...raw, content: unwrapPastedContent(raw.content) };
    if (raw.type === "queue-operation" && raw.operation === "remove" && typeof raw.content === "string") {
      return { type: "phren_queue_consumed", key: createHash("sha256").update(raw.content).digest("hex"), timestamp: raw.timestamp };
    }
    // Claude Code records background completion as an internal queue row,
    // outside the ordinary user/assistant transcript. Export only the small
    // task-notification envelope; other internal events remain private.
    if (raw.type === "queue-operation" && typeof raw.content === "string"
        && raw.content.length <= 65_536 && raw.content.includes("<task-notification>")
        && raw.content.includes("<tool-use-id>")) {
      const content = taskNotification(raw.content);
      return content ? { type: "system", phrenBackground: true, timestamp: raw.timestamp,
        message: { role: "user", content } } : undefined;
    }
    // A message sent while the agent was mid-turn is only ever a queue row:
    // Claude Code hands it to the model inside a later tool result and never
    // writes a user turn for it. Export the enqueue as the person's message so
    // the phone can draw the bubble it sent. Consumption exposes only a digest.
    if (raw.type === "queue-operation" && ["enqueue", "remove"].includes(String(raw.operation))
        && !raw.isMeta && !raw.isSidechain && typeof raw.content === "string"
        && raw.content.length <= 65_536 && !raw.content.includes("<task-notification>")) {
      // The paste wrapper was removed above; any envelope still starting
      // with "<" is the harness's own and stays private.
      if (raw.content.trimStart().startsWith("<")) return undefined;
      const text = raw.content;
      const key = createHash("sha256").update(raw.content).digest("hex");
      // Only the identity crosses the wire on consumption: no queue payload,
      // tool envelope, private metadata, or reasoning is exported.
      if (raw.operation === "remove") return { type: "phren_queue_consumed", key, timestamp: raw.timestamp };
      return { type: "user", phrenQueued: true, phrenQueueKey: key, timestamp: raw.timestamp,
        message: { role: "user", content: text } };
    }
    if (raw.isMeta || (raw.isSidechain && !includeSidechain) || !["user", "assistant", "system"].includes(String(raw.type))) return undefined;
    raw = Object.fromEntries(Object.entries(raw).filter(([key]) => CLAUDE_KEYS.has(key)));
    const message = unwrapUserText(object(raw.message));
    // Keep indexes for historical images while removing thinking contents.
    if (typeof message.content === "string") return raw.type === "user" && harnessPreamble(message.content) ? undefined : { ...raw, message };
    if (Array.isArray(message.content)) return { ...raw, message: { ...message, content: objects(message.content).map(b =>
      ["text", "image", "tool_use", "tool_result"].includes(String(b.type)) ? b : { type: "redacted" }) } };
  } else {
    if (raw.agentId || raw.ephemeral || !["user.message", "assistant.message", "assistant.message_delta", "tool.execution_start", "tool.execution_complete", "assistant.turn_start", "assistant.turn_end", "session.idle", "abort", "session.error", "session.usage_info", "assistant.usage"].includes(String(raw.type))) return undefined;
    const data = object(raw.data);
    // Copilot includes optional reasoning beside the public message in some
    // versions. Export only the fields used by public text/tool/usage readers.
    const allowed = ["content", "source", "messageId", "deltaContent", "toolName", "toolCallId", "arguments", "result", "error", "aborted", "inputTokens", "outputTokens", "cacheReadTokens"];
    return { type: raw.type, timestamp: raw.timestamp, data: Object.fromEntries(Object.entries(data).filter(([key]) => allowed.includes(key))) };
  }
  return undefined;
}

/** Parse only the requested page; shared byte indexes make reopening and
 * backward pagination independent of the amount of already-read history. */
export class TranscriptReader {
  private revision?: string;
  private nextLine = 0;
  constructor(readonly file: string, readonly source: Provider, private readonly imageLine?: number, private readonly changes?: ChangeLookup,
              private readonly includeSidechain = false) {}
  async read(before?: number, signal?: AbortSignal): Promise<{ entries: Entry[]; totalLines: number; startLine: number; hasMore: boolean; reset: boolean }> {
    return withTranscriptIndex(this.file, async (handle, index) => {
      const reset = this.revision !== index.revision;
      const end = Math.min(before ?? index.lines, index.lines);
      const lower = this.imageLine ?? (reset || before !== undefined ? 0 : this.nextLine);
      const entries: Entry[] = [];
      // The first page of a conversation is what the phone parses and lays
      // out before anything shows; keep it light and let scrolling fetch the
      // rest in fuller pages. A live tail (nextLine known) stays small too.
      const opening = before === undefined && (reset || this.nextLine === 0);
      const entryBudget = opening ? 60 : 200;
      const byteBudget = opening ? 1_048_576 : 4_194_304;
      let bytes = 0, cursor = end, held: number | undefined;
      for await (const row of index.rows(handle, end, lower, signal)) {
        signal?.throwIfAborted();
        let entry: Entry | undefined;
        try {
          let raw = row.bytes && visibleEvent(object(JSON.parse(row.bytes.toString())), this.source, this.includeSidechain);
          // A child agent's transcript is the sidechain. Its rows are that
          // conversation's own turns, not something for the reader to skip.
          if (raw && this.includeSidechain && raw.isSidechain === true) { const { isSidechain: _sidechain, ...own } = raw; raw = own; }
          if (raw) entry = { line: row.line, raw: this.imageLine === row.line ? raw : chatFrame(raw, this.source) };
        } catch { /* A malformed old row cannot block the next readable page. */ }
        if (entry && this.changes && this.imageLine === undefined) {
          // A shell call's output carries what it changed on disk. While that
          // diff is still being computed on the live tail, the row — and the
          // newer rows already collected — wait for the next read.
          const ids = outputCallIds(entry.raw, this.source);
          if (before === undefined && ids.some(id => this.changes!.pending(id))) { held = row.line; entries.length = 0; bytes = 0; cursor = row.line; continue; }
          const attached: Json = {};
          for (const id of ids) { const files = await this.changes.changes(id); if (files) attached[id] = files; }
          if (Object.keys(attached).length) entry.raw = { ...entry.raw, phren_changes: attached };
        }
        if (entry) {
          const size = Buffer.byteLength(JSON.stringify(entry));
          if (this.imageLine !== undefined || size < 2_097_152) {
            // Leave an entry that doesn't fit for the following history page.
            if (this.imageLine === undefined && bytes + size > byteBudget) break;
            entries.push(entry); bytes += size;
          }
        }
        cursor = row.line;
        if (entries.length >= entryBudget) break;
      }
      if (before === undefined) { this.revision = index.revision; this.nextLine = held ?? index.lines; }
      return { entries: entries.reverse(), totalLines: index.lines, startLine: cursor, hasMore: cursor > 0, reset };
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
