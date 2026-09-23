import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import path from "node:path";
import { object, objects, type Json } from "./protocol.js";
import type { ChildAgentRelation } from "./transcripts.js";

/** Claude Code's transcript reader: Task sidechains and named teammates as
 * child agents, and the public rows of a conversation. */

const claudeRelationCache = new Map<string, { signature: string; relations: ChildAgentRelation[]; recheckAt?: number }>();
type ClaudeChildModelCache = { dev: number; ino: number; size: number; model?: string };
const claudeChildModelCache = new Map<string, ClaudeChildModelCache>();

function cacheClaudeChildModel(file: string, entry: ClaudeChildModelCache): void {
  claudeChildModelCache.set(file, entry);
  while (claudeChildModelCache.size > 128) claudeChildModelCache.delete(claudeChildModelCache.keys().next().value!);
}

/** The model is available on the first assistant turn of a Claude sidechain.
 * A growing transcript without that turn is retried; a known model is final. */
async function claudeChildModel(file: string): Promise<string | undefined> {
  const metadata = await stat(file), cached = claudeChildModelCache.get(file);
  if (cached && cached.dev === metadata.dev && cached.ino === metadata.ino
      && (cached.model !== undefined || metadata.size <= cached.size)) return cached.model;
  let model: string | undefined;
  if (metadata.size > 0) {
    const bytes = Math.min(metadata.size, 65_536);
    const input = createInterface({ input: createReadStream(file, { start: 0, end: bytes - 1 }), crlfDelay: Infinity });
    let lines = 0;
    for await (const line of input) {
      ++lines;
      try {
        const raw = object(JSON.parse(line));
        if (raw.type === "assistant") {
          const value = object(raw.message).model;
          if (typeof value === "string" && value.length > 0 && value.length <= 200) model = value;
          break;
        }
      } catch { /* Ignore malformed rows while looking for the first assistant turn. */ }
      if (lines === 200) break;
    }
  }
  cacheClaudeChildModel(file, { dev: metadata.dev, ino: metadata.ino, size: metadata.size, ...(model !== undefined ? { model } : {}) });
  return model;
}

async function withClaudeChildModels(relations: ChildAgentRelation[]): Promise<ChildAgentRelation[]> {
  return Promise.all(relations.map(async relation => {
    if (relation.model !== undefined || relation.transcript === undefined) return relation;
    const model = await claudeChildModel(relation.transcript).catch(() => undefined);
    return model === undefined ? relation : { ...relation, model };
  }));
}

export async function claudeChildAgents(file: string, session: string): Promise<ChildAgentRelation[]> {
  const metadata = await stat(file), signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  const cached = claudeRelationCache.get(file);
  if (cached?.signature === signature && !(cached.recheckAt !== undefined && Date.now() >= cached.recheckAt)) {
    cached.relations = await withClaudeChildModels(cached.relations);
    return cached.relations;
  }
  const launches = new Map<string, { path: string; callId: string; state: "running" | "completed" }>();
  // Named teammates (the Agent tool with a `name`) run as their own session
  // and never post a task-notification: they announce themselves idle in a
  // teammate-message instead, and may be woken again later. Their file is
  // `agent-a<name>-<hex>.jsonl` beside the Task sidechains.
  const teammates = new Map<string, { path: string; callId: string; state: "running" | "completed" }>();
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const raw = object(JSON.parse(line)), result = object(raw.toolUseResult);
      const agentId = String(result.agentId ?? ""), status = String(result.status ?? "");
      if (/^[A-Za-z0-9._-]{1,128}$/.test(agentId) && ["async_launched", "running"].includes(status)) {
        const blocks = objects(object(raw.message).content), callId = String(blocks.find(b => b.type === "tool_result")?.tool_use_id ?? "");
        if (callId) launches.set(agentId, { path: String(result.description || result.name || "Agent").slice(0, 200), callId, state: "running" });
      }
      if (raw.type === "assistant") {
        for (const block of objects(object(raw.message).content)) {
          if (block.type !== "tool_use" || block.name !== "Agent") continue;
          const input = object(block.input), name = String(input.name ?? "");
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || typeof block.id !== "string") continue;
          teammates.set(name, { path: String(input.description || name).slice(0, 200), callId: block.id.slice(0, 200), state: "running" });
        }
      }
      const content = typeof raw.content === "string" ? raw.content : typeof object(raw.message).content === "string" ? String(object(raw.message).content) : "";
      if (content.includes("<task-notification>")) {
        const child = /<task-id>([^<>]{1,128})<\/task-id>/.exec(content)?.[1], taskStatus = /<status>([^<>]+)<\/status>/.exec(content)?.[1];
        // A stopped agent's notification says "killed"; it is finished as
        // much as a completed one and must leave the running count.
        const previous = child && launches.get(child); if (previous && ["completed", "failed", "cancelled", "killed"].includes(taskStatus ?? "")) previous.state = "completed";
      }
      if (content.includes("<teammate-message")) {
        const from = /<teammate-message teammate_id="([A-Za-z0-9][A-Za-z0-9_-]{0,63})"/.exec(content)?.[1];
        const teammate = from && teammates.get(from);
        if (teammate) teammate.state = content.includes("\"type\":\"idle_notification\"") ? "completed" : "running";
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
    const model = await claudeChildModel(childFile).catch(() => undefined);
    relations.push({ id: createHash("sha256").update(`claude\0${session}\0${agentId}`).digest("hex").slice(0, 32),
      session: agentId, transcript: childFile, provider: "claude", ...launch,
      ...(model !== undefined ? { model } : {}), children: [] });
  }
  if (teammates.size && root) {
    const names = (await readdir(root).catch(() => [] as string[])).filter(n => /^agent-a[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[0-9a-f]{8,32}\.jsonl$/.test(n));
    for (const [name, launch] of teammates) {
      const fileName = names.find(n => n.startsWith(`agent-a${name}-`));
      const agentId = fileName?.slice("agent-".length, -".jsonl".length);
      const childFile = agentId && await realpath(path.join(root, fileName!)).catch(() => undefined);
      if (!agentId || !childFile || !childFile.startsWith(root + path.sep) || !await claudeChildBelongsTo(childFile, session, agentId)) {
        if (launch.state === "running") awaiting = true;
        continue;
      }
      // The meta file names the model as the launcher chose it ("sonnet");
      // the transcript's first assistant turn carries the full id and wins.
      const meta = await readFile(childFile.slice(0, -".jsonl".length) + ".meta.json", "utf8").then(v => object(JSON.parse(v))).catch(() => ({} as Json));
      const model = await claudeChildModel(childFile).catch(() => undefined) ?? (typeof meta.model === "string" && meta.model ? meta.model.slice(0, 200) : undefined);
      relations.push({ id: createHash("sha256").update(`claude\0${session}\0${agentId}`).digest("hex").slice(0, 32),
        session: agentId, transcript: childFile, provider: "claude", ...launch,
        ...(model !== undefined ? { model } : {}), children: [] });
    }
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

const CLAUDE_KEYS = new Set(["type", "uuid", "parentUuid", "timestamp", "message", "gitBranch", "cwd", "requestId", "isMeta", "isSidechain", "isCompactSummary", "phrenQueued", "phrenQueueKey", "phrenBackground", "phrenCompacted"]);
export const harnessPreamble = (text: string) => /^<(?:environment_context>|user_instructions>|permission_profile|system-reminder>|turn_context>)/.test(text.trimStart());

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

/** A thinking block Claude marks as narration for the person watching: its
 * signature is a length-prefixed field reading "narration" (private
 * reasoning reads "thinking" and is stored without text). */
export function isNarration(block: Record<string, unknown>): boolean {
  if (block.type !== "thinking" || typeof block.thinking !== "string" || !block.thinking.trim()) return false;
  if (typeof block.signature !== "string" || block.signature.length > 16_384) return false;
  let bytes: Buffer;
  try { bytes = Buffer.from(block.signature, "base64"); } catch { return false; }
  return bytes.subarray(0, 96).includes(Buffer.from([0x42, 0x09, ...Buffer.from("narration")]));
}

/** Claude Code rows the phone may see: user, assistant and system turns with
 * private reasoning redacted, queued phone messages, background task
 * notifications and compaction markers. */
export function visibleClaudeEvent(raw: Json, includeSidechain = false): Json | undefined {
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
  // Claude Code appends a boundary marker and then the summary it hands the
  // model as a user turn. The phone shows the marker and a bounded preview,
  // never the full summary as a bubble.
  if (raw.type === "system" && raw.subtype === "compact_boundary") {
    return { type: "system", phrenCompacted: true, timestamp: raw.timestamp };
  }
  if (raw.type === "user" && raw.isCompactSummary === true) {
    const content = object(raw.message).content;
    return { type: "user", isCompactSummary: true, timestamp: raw.timestamp,
      message: { role: "user", content: (typeof content === "string" ? content : "").slice(0, 4_000) } };
  }
  if (raw.isMeta || (raw.isSidechain && !includeSidechain) || !["user", "assistant", "system"].includes(String(raw.type))) return undefined;
  raw = Object.fromEntries(Object.entries(raw).filter(([key]) => CLAUDE_KEYS.has(key)));
  const message = unwrapUserText(object(raw.message));
  // Keep indexes for historical images while removing thinking contents.
  // The one exception is narration: short progress notes the model writes
  // for the person watching (the lines Claude Code's terminal shows between
  // tool calls). They arrive as thinking blocks whose signature declares
  // them narration and whose text is present; private reasoning is stored
  // with empty text and a "thinking" signature and stays redacted.
  if (typeof message.content === "string") return raw.type === "user" && harnessPreamble(message.content) ? undefined : { ...raw, message };
  if (Array.isArray(message.content)) return { ...raw, message: { ...message, content: objects(message.content).map(b =>
    ["text", "image", "tool_use", "tool_result"].includes(String(b.type)) ? b
      : isNarration(b) ? { type: "text", text: String(b.thinking), narration: true } : { type: "redacted" }) } };
  return undefined;
}
