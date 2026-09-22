import { readdir, readFile, realpath, stat, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { withTranscriptIndex } from "./transcript-index.js";
import { BridgeError, object, objects, sessionId, type Json, type Provider, type Target } from "./protocol.js";
import { materializeCodexThread, materializedRoot } from "./codex-threads.js";
import { namedPaths, SHELL_TOOLS, outputCallIds, type ChangeLookup } from "./changes.js";
import { fanoutChildren, visibleCodexExecEvent, visibleOpenCodeRunEvent } from "./fanouts.js";

export interface Entry { line: number; raw: Json }
export interface ChildAgentRelation {
  /** `id` is a parent-scoped public reference; local session and transcript details never leave Hook. */
  id: string; session?: string; transcript?: string; provider: Provider; path: string; callId: string; state: "running" | "completed" | "failed" | "unavailable";
  /** Why a fan-out worker did not finish: `blocked: <type> <pattern>`. */
  reason?: string;
  finishedAt?: string;
  /** Fan-out manifests and Claude child transcripts can name a model. */
  model?: string;
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
type DirectRelation = Pick<LocalChildAgentRelation, "session" | "path" | "callId" | "state">;
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
    // Codex 0.155 also reports "interacted" between start and completion;
    // it proves the child exists without changing its state.
    if (!["started", "interacted", "completed"].includes(kind) || !sessionId.safeParse(child).success || !callId || agentPath.length > 512) return;
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

async function claudeChildAgents(file: string, session: string): Promise<ChildAgentRelation[]> {
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
  return tree.map(({ id, provider, path: agentPath, callId, state, reason, finishedAt, model, worktreeName, branch, computer, remote, children }) =>
    // A blocked worker is finished; the phone's relation contract has no failed
    // state, so the reason carries what happened without breaking old clients.
    ({ id, provider, path: agentPath, callId, state: state === "failed" ? "completed" : state,
      ...(state === "failed" ? { failed: true } : {}), ...(finishedAt ? { finishedAt } : {}),
      ...(reason !== undefined ? { reason } : {}), ...(model !== undefined ? { model } : {}),
      ...(worktreeName !== undefined ? { worktreeName } : {}), ...(branch !== undefined ? { branch } : {}),
      ...(computer !== undefined ? { computer: { id: computer.id, name: computer.name } } : {}),
      ...(remote !== undefined ? { remote: { target: remote.target, ...(remote.child !== undefined ? { child: remote.child } : {}) } } : {}),
      children: publicChildAgents(children) }));
}

export function childAgent(tree: ChildAgentRelation[], id: string): LocalChildAgentRelation | undefined {
  for (const node of tree) {
    if (node.remote !== undefined) continue;
    if (node.id === id && node.session !== undefined && node.transcript !== undefined) return node as LocalChildAgentRelation;
    const nested = childAgent(node.children, id); if (nested) return nested;
  }
}

const CLAUDE_KEYS = new Set(["type", "uuid", "parentUuid", "timestamp", "message", "gitBranch", "cwd", "requestId", "isMeta", "isSidechain", "isCompactSummary", "phrenQueued", "phrenQueueKey", "phrenBackground", "phrenCompacted"]);
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

export async function transcriptPath(source: Provider, session: string): Promise<string> {
  if (!sessionId.safeParse(session).success) throw new BridgeError(400, "Invalid conversation identity.");
  const base = source === "codex" ? path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions")
    : source === "claude" ? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects")
    : source === "phren" || source === "opencode" ? path.join(phrenStoreRoot(), ".runtime", "sessions")
    : path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "session-state");
  const root = await realpath(base).catch(() => base);
  const pattern = source === "codex" ? `*/*/*/rollout-*-${session}.jsonl` : source === "claude" ? `*/${session}.jsonl`
    : source === "phren" ? `session-${session}.events.jsonl` : source === "opencode" ? `opencode-${session}.events.jsonl` : `${session}/events.jsonl`;
  const matches = await findPatternMatches(root, pattern).catch(() => [] as string[]);
  if (matches.length !== 1) {
    // Codex 0.155 keeps new threads only in its sqlite store; the Hook
    // materializes those into a rollout-shaped file of its own.
    const materialized = source === "codex" ? await materializeCodexThread(session) : undefined;
    if (materialized) return materialized;
    throw new BridgeError(404, "The transcript is not available for this conversation.");
  }
  const file = await realpath(matches[0]);
  if (!file.startsWith(root + path.sep)) throw new BridgeError(403, "The transcript points outside its agent folder.");
  return file;
}

/** Keeps a materialized Codex thread current before a read; a no-op for
 * transcripts the agent writes itself. */
export async function refreshTranscript(file: string, source: Provider, session: string): Promise<void> {
  if (source === "codex" && file.startsWith(materializedRoot() + path.sep)) await materializeCodexThread(session);
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
export function visibleEvent(raw: Json, source: Provider, includeSidechain = false, cwd?: string): Json | undefined {
  if (source === "opencode") {
    const runEvent = visibleOpenCodeRunEvent(raw, cwd); if (runEvent) return runEvent;
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

/** Codex 0.155 code mode: the model calls one generic tool whose input is
 * JavaScript, and that source invokes `tools.apply_patch`/`tools.shell`/
 * `tools.read`. The Hook resolves each invocation into the ordinary call the
 * phone already draws, so a patch shows a diff instead of an opaque source. */
export interface CodeToolCall { name: "apply_patch" | "shell" | "read"; input: Json }
const CODE_TOOL_CALL = /\btools\s*\.\s*(apply_patch|shell|read)\s*\(/g;
const JS_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "'": "'", '"': '"', "\\": "\\", "/": "/" };

function unescapeJs(value: string): string {
  return value.replace(/\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_match, escape: string) => {
    if (escape[0] === "u") {
      const code = parseInt(escape[1] === "{" ? escape.slice(2, -1) : escape.slice(1), 16);
      return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    if (escape[0] === "x") { const code = parseInt(escape.slice(1), 16); return Number.isFinite(code) ? String.fromCharCode(code) : ""; }
    return JS_ESCAPES[escape] ?? escape;
  });
}

/** The value of a string literal, or undefined when the expression is not one. */
function literalValue(expression: string): string | undefined {
  const text = expression.trim(), quote = text[0];
  if (!["'", '"', "`"].includes(quote) || text.length < 2 || text[text.length - 1] !== quote) return undefined;
  for (let index = 1; index < text.length - 1; index++) {
    if (text[index] === "\\") { index++; continue; }
    if (text[index] === quote) return undefined;
  }
  return unescapeJs(text.slice(1, -1));
}

/** Resolve a call argument: an inline literal, or an identifier assigned a
 * string literal in the same source. Computed values stay unresolved. */
function resolveString(expression: string, source: string): string | undefined {
  const literal = literalValue(expression);
  if (literal !== undefined) return literal;
  const identifier = expression.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(identifier)) return undefined;
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`).exec(source);
  return declaration ? unescapeJs(declaration[1].slice(1, -1)) : undefined;
}

/** The `(…)` text of a call, skipping parentheses inside string literals. */
function callArguments(source: string, open: number): string | undefined {
  let depth = 0, quote = "";
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (quote) { if (character === "\\") index++; else if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "(" || character === "{" || character === "[") depth++;
    else if (character === ")" || character === "}" || character === "]") { if (--depth === 0) return source.slice(open + 1, index); }
  }
  return undefined;
}

function shellCommand(expression: string, source: string): string | undefined {
  const inline = resolveString(expression, source);
  if (inline !== undefined) return inline;
  const inner = /^\{([\s\S]*)\}$/.exec(expression.trim())?.[1];
  if (inner === undefined) return undefined;
  const body = inner.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(body)) return resolveString(body, source);
  const property = /(?:^|[,{])\s*(?:command|cmd)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*)/.exec(body);
  return property ? resolveString(property[1], source) : undefined;
}

/** Every recognized invocation in a code-mode source, in the order written. */
export function codeToolCalls(source: string): CodeToolCall[] | undefined {
  const calls: CodeToolCall[] = [], original = source.slice(0, 262_144);
  for (const match of source.matchAll(CODE_TOOL_CALL)) {
    const args = callArguments(source, (match.index ?? 0) + match[0].length - 1);
    if (args === undefined) continue;
    if (match[1] === "apply_patch") {
      const patch = resolveString(args, source);
      if (patch?.startsWith("*** Begin Patch")) calls.push({ name: "apply_patch", input: { patch, source: original } });
    } else if (match[1] === "shell") {
      const command = shellCommand(args, source);
      if (command !== undefined) calls.push({ name: "shell", input: { command, source: original } });
    } else {
      const file = resolveString(args, source);
      if (file !== undefined) calls.push({ name: "read", input: { file_path: file, source: original } });
    }
  }
  return calls.length ? calls : undefined;
}

/** The JS source behind a code-mode input: a raw string, or an object carrying
 * it under a code/source/script field. JSON tool arguments are not source. */
function codeToolSource(input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trimStart();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = object(JSON.parse(input));
        // A resolved call (our own projection, or ordinary JSON arguments such
        // as `command`) is not source, even when it also carries `source`.
        if (["patch", "command", "cmd", "file_path", "files"].some(key => parsed[key] !== undefined)) return undefined;
        for (const key of ["code", "source", "script", "input"]) if (typeof parsed[key] === "string") return parsed[key] as string;
        return undefined;
      } catch { return input; }
    }
    return input;
  }
  const fields = object(input);
  for (const key of ["code", "source", "script", "input"]) if (typeof fields[key] === "string") return fields[key] as string;
  return undefined;
}

const projectedCodeCalls = new Set<string>();
function rememberProjectedCodeCall(callId: string): void {
  projectedCodeCalls.delete(callId); projectedCodeCalls.add(callId);
  while (projectedCodeCalls.size > 4096) projectedCodeCalls.delete(projectedCodeCalls.values().next().value!);
}
function renameProjectedChanges(raw: Json, base: string): Json {
  const changes = object(raw.phren_changes);
  if (!Object.keys(changes).length) return raw;
  return { ...raw, phren_changes: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key === base ? `${base}:1` : key, value])) };
}

/** Expand one Codex row: a code-mode call becomes one ordinary call per
 * invocation, each carrying the original source under `input.source`, and the
 * matching result follows the first. Other rows pass through unchanged. */
export function projectCodexRow(raw: Json): { rows: Json[]; base?: string } {
  if (raw.type !== "response_item") return { rows: [raw] };
  const payload = object(raw.payload), type = String(payload.type), callId = typeof payload.call_id === "string" ? payload.call_id : "";
  if (type === "custom_tool_call" || type === "function_call") {
    const source = codeToolSource(payload.input ?? payload.arguments);
    const calls = source === undefined ? undefined : codeToolCalls(source);
    if (!calls) return { rows: [raw] };
    const rows = calls.map((call, index) => ({ type: "response_item", payload: { type: "function_call",
      name: call.name, call_id: `${callId}:${index + 1}`, arguments: JSON.stringify(call.input) } }));
    if (callId) rememberProjectedCodeCall(callId);
    return { rows, ...(callId ? { base: callId } : {}) };
  }
  if ((type === "custom_tool_call_output" || type === "function_call_output") && callId && projectedCodeCalls.has(callId)) {
    return { rows: [{ ...renameProjectedChanges(raw, callId), payload: { ...payload, call_id: `${callId}:1` } }], base: callId };
  }
  return { rows: [raw] };
}

/** The output row for a projected call is read before its call (newest row
 * first), so an output already collected in this page follows the first. */
function rewriteProjectedOutput(entries: Entry[], base: string): void {
  for (const entry of entries) {
    const payload = object(entry.raw.payload);
    if (payload.call_id !== base) continue;
    entry.raw = { ...renameProjectedChanges(entry.raw, base), payload: { ...payload, call_id: `${base}:1` } };
  }
}

/** Parse only the requested page; shared byte indexes make reopening and
 * backward pagination independent of the amount of already-read history. */
export class TranscriptReader {
  private revision?: string;
  private nextLine = 0;
  constructor(readonly file: string, readonly source: Provider, private readonly imageLine?: number, private readonly changes?: ChangeLookup,
              private readonly includeSidechain = false, private readonly cwd?: string) {}
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
      for await (const row of index.rows(handle, end, lower, signal)) {
        signal?.throwIfAborted();
        let rows: Json[] = [];
        try {
          let raw = row.bytes && visibleEvent(object(JSON.parse(row.bytes.toString())), this.source, this.includeSidechain, this.cwd);
          // A child agent's transcript is the sidechain. Its rows are that
          // conversation's own turns, not something for the reader to skip.
          if (raw && this.includeSidechain && raw.isSidechain === true) { const { isSidechain: _sidechain, ...own } = raw; raw = own; }
          if (raw) {
            if (this.changes && this.imageLine === undefined) {
              // A shell call's output carries what it changed on disk. While
              // that diff is still being computed on the live tail, the row
              // (and the newer rows already collected) waits for the next read.
              const ids = outputCallIds(raw, this.source);
              if (before === undefined && ids.some(id => this.changes!.pending(id))) { held = row.line; entries.length = 0; bytes = 0; cursor = row.line; continue; }
              const attached: Json = {};
              for (const id of ids) { const files = await this.changes.changes(id); if (files) attached[id] = files; }
              // A row that already carries a worker's own diff (OpenCode edit,
              // write or patch) keeps it; the shell lookup only fills in the rest.
              if (Object.keys(attached).length) raw = { ...raw, phren_changes: { ...attached, ...object(raw.phren_changes) } };
            }
            const projected = this.source === "codex" ? projectCodexRow(raw) : { rows: [raw] as Json[] };
            rows = this.imageLine === row.line ? projected.rows : projected.rows.map(r => chatFrame(r, this.source));
            if (projected.base) rewriteProjectedOutput(entries, projected.base);
          }
        } catch { /* A malformed old row cannot block the next readable page. */ }
        if (rows.length) {
          const size = Buffer.byteLength(JSON.stringify(rows));
          if (this.imageLine !== undefined || size < 2_097_152) {
            // Leave an entry that doesn't fit for the following history page.
            if (this.imageLine === undefined && bytes + size > byteBudget) break;
            // Rows arrive newest first; reverse a row's blocks so the page
            // lists several calls from one source in the order they were written.
            entries.push(...rows.slice().reverse().map(raw => ({ line: row.line, raw })));
            bytes += size;
          }
        }
        cursor = row.line;
        if (entries.length >= entryBudget) break;
      }
      if (before === undefined) { this.revision = index.revision; this.nextLine = held ?? index.lines; }
      return { entries: entries.reverse(), totalLines: index.lines, startLine: cursor, hasMore: cursor > 0,
        reset: resuming && !pastEnd ? false : reset };
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
