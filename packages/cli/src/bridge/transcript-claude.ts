import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import path from "node:path";
import { object, objects, type Json } from "./protocol.js";
import type { ChildAgentRelation } from "./transcripts.js";

/** Claude Code's transcript reader: Task sidechains and named teammates as
 * child agents, and the public rows of a conversation. */

type ClaudeLaunch = { path: string; callId: string; state: "running" | "completed" };
type ClaudeWorkflow = { runId: string; name: string; callId: string; state: "running" | "completed" };
/** What the parent transcript says of its children, kept so a timed recheck
 * of an unchanged parent reads only the children, never the parent again. */
interface ClaudeParentRows { launches: Map<string, ClaudeLaunch>; skills: Set<string>; workflows: Map<string, ClaudeWorkflow>; teammates: Map<string, ClaudeLaunch> }
const claudeRelationCache = new Map<string, { signature: string; relations: ChildAgentRelation[]; recheckAt?: number; rows?: ClaudeParentRows }>();
const copyRows = (rows: ClaudeParentRows): ClaudeParentRows => ({ launches: new Map([...rows.launches].map(([id, launch]) => [id, { ...launch }])),
  skills: new Set(rows.skills), workflows: new Map([...rows.workflows].map(([id, workflow]) => [id, { ...workflow }])),
  teammates: new Map([...rows.teammates].map(([name, launch]) => [name, { ...launch }])) });
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

/** The checkout a Claude sub-agent edits in. Claude Code writes the isolated
 * worktree into the child's `.meta.json`; an older child falls back to the
 * `cwd` its own first rows record when that folder is a linked worktree (its
 * `.git` is a file). A child working in the parent's checkout gets nothing,
 * and a worktree already removed is not offered. */
export async function claudeChildCheckout(file: string): Promise<Pick<ChildAgentRelation, "cwd" | "worktreeName" | "branch">> {
  const meta = await readFile(file.slice(0, -".jsonl".length) + ".meta.json", "utf8").then(v => object(JSON.parse(v))).catch(() => ({} as Json));
  let cwd = typeof meta.worktreePath === "string" && path.isAbsolute(meta.worktreePath) ? meta.worktreePath : undefined;
  let branch = typeof meta.worktreeBranch === "string" && meta.worktreeBranch ? meta.worktreeBranch.slice(0, 200) : undefined;
  if (!cwd) {
    const input = createInterface({ input: createReadStream(file, { start: 0, end: 65_535 }), crlfDelay: Infinity });
    let lines = 0;
    for await (const line of input) {
      try {
        const value = object(JSON.parse(line)).cwd;
        if (typeof value === "string" && path.isAbsolute(value)) {
          if ((await stat(path.join(value, ".git")).catch(() => undefined))?.isFile()) cwd = value;
          break;
        }
      } catch { /* Keep looking past a malformed row. */ }
      if (++lines >= 40) break;
    }
    input.close();
    branch = undefined;
  }
  if (!cwd || !(await stat(cwd).catch(() => undefined))?.isDirectory()) return {};
  return { cwd, worktreeName: path.basename(cwd).slice(0, 200), ...(branch ? { branch } : {}) };
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
  // A recheck of an unchanged parent (a launch whose transcript was not there
  // yet, a background skill or workflow still running) reads only the children.
  const rows = cached?.signature === signature && cached.rows ? cached.rows : await claudeParentRows(file);
  return claudeChildRelations(file, session, signature, rows);
}

async function claudeParentRows(file: string): Promise<ClaudeParentRows> {
  const launches = new Map<string, ClaudeLaunch>();
  const stops = new Map<string, string>();
  // A background skill (`/code-review` run as `@code-review`) is announced in
  // a local-command row, not a tool result, and its end is read from its own
  // transcript (claudeSkillFinished).
  const skills = new Set<string>();
  // A Workflow run, by its task id: its agents are in the run's journal.
  const workflows = new Map<string, ClaudeWorkflow>();
  // Named teammates (the Agent tool with a `name`) run as their own session
  // and never post a task-notification: they announce themselves idle in a
  // teammate-message instead, and may be woken again later. Their file is
  // `agent-a<name>-<hex>.jsonl` beside the Task sidechains.
  const teammates = new Map<string, ClaudeLaunch>();
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const raw = object(JSON.parse(line)), result = object(raw.toolUseResult);
      const blocks = objects(object(raw.message).content);
      const agentId = String(result.agentId ?? ""), status = String(result.status ?? "");
      if (/^[A-Za-z0-9._-]{1,128}$/.test(agentId) && ["async_launched", "running"].includes(status)) {
        const callId = String(blocks.find(b => b.type === "tool_result")?.tool_use_id ?? "");
        if (callId) launches.set(agentId, { path: String(result.description || result.name || "Agent").slice(0, 200), callId, state: "running" });
      }
      // SendMessage to a finished agent resumes it until its next final notification.
      const resumed = typeof result.resumedAgentId === "string" ? launches.get(result.resumedAgentId) : undefined;
      if (resumed && typeof result.message === "string" && /^Resuming agent\b/i.test(result.message)) resumed.state = "running";
      if (result.taskType === "local_workflow" && status === "async_launched" && typeof result.taskId === "string"
          && typeof result.runId === "string" && /^wf_[A-Za-z0-9-]{1,64}$/.test(result.runId)) {
        const callId = String(blocks.find(b => b.type === "tool_result")?.tool_use_id ?? "");
        workflows.set(result.taskId, { runId: result.runId, name: String(result.workflowName || "Workflow").slice(0, 200), callId, state: "running" });
      }
      if (raw.type === "system" && typeof raw.content === "string" && raw.content.includes("<forked-skill-launch>")) {
        const launch = object(JSON.parse(/<forked-skill-launch>([\s\S]*?)<\/forked-skill-launch>/.exec(raw.content)?.[1] ?? "{}"));
        const id = String(launch.agentId ?? "");
        if (/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
          launches.set(id, { path: String(launch.description || (launch.skillName ? `/${launch.skillName}` : "Skill")).slice(0, 200), callId: `skill:${id}`, state: "running" });
          skills.add(id);
        }
      }
      if (raw.type === "assistant") {
        for (const block of blocks) {
          if (block.type !== "tool_use") continue;
          if (block.name === "TaskStop" && typeof block.id === "string" && typeof object(block.input).task_id === "string") {
            stops.set(block.id, String(object(block.input).task_id));
          }
          if (block.name !== "Agent") continue;
          const input = object(block.input), name = String(input.name ?? "");
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || typeof block.id !== "string") continue;
          teammates.set(name, { path: String(input.description || name).slice(0, 200), callId: block.id.slice(0, 200), state: "running" });
        }
      }
      // A stop request alone proves nothing. Its successful, matching result
      // ends the child even when no later task notification is recorded.
      if (raw.type === "user") {
        for (const block of blocks) {
          if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const task = stops.get(block.tool_use_id);
          if (!task) continue;
          stops.delete(block.tool_use_id);
          const previous = launches.get(task) ?? workflows.get(task);
          if (previous && block.is_error !== true && result.task_id === task && typeof result.message === "string"
              && /^Successfully stopped task\b/i.test(result.message)) previous.state = "completed";
        }
      }
      const content = typeof raw.content === "string" ? raw.content : typeof object(raw.message).content === "string" ? String(object(raw.message).content) : "";
      const attachment = object(raw.attachment);
      const notices = [raw.type === "queue-operation" || raw.type === "user" ? content : "",
        ...(raw.type === "user" ? blocks.filter(block => block.type === "text" && typeof block.text === "string").map(block => String(block.text)) : []),
        raw.type === "attachment" && attachment.type === "queued_command" && attachment.commandMode === "task-notification" && typeof attachment.prompt === "string" ? attachment.prompt : ""];
      for (const notice of notices) {
        for (const match of notice.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
          const child = /<task-id>([^<>]{1,128})<\/task-id>/.exec(match[1])?.[1], taskStatus = /<status>([^<>]+)<\/status>/.exec(match[1])?.[1].trim();
          // Terminal notifications end only the child named in that envelope.
          const previous = child && (launches.get(child) ?? workflows.get(child));
          if (previous && ["completed", "failed", "cancelled", "canceled", "killed", "stopped"].includes(taskStatus ?? "")) previous.state = "completed";
        }
      }
      if (content.includes("<teammate-message")) {
        const from = /<teammate-message teammate_id="([A-Za-z0-9][A-Za-z0-9_-]{0,63})"/.exec(content)?.[1];
        const teammate = from && teammates.get(from);
        if (teammate) teammate.state = content.includes("\"type\":\"idle_notification\"") ? "completed" : "running";
      }
    } catch { /* Ignore unrelated/malformed rows. */ }
  }
  return { launches, skills, workflows, teammates };
}

async function claudeChildRelations(file: string, session: string, signature: string, rows: ClaudeParentRows): Promise<ChildAgentRelation[]> {
  // Kept as the parent wrote them: what follows marks finished children.
  const kept = copyRows(rows);
  const { launches, skills, workflows, teammates } = copyRows(rows);
  const relations: ChildAgentRelation[] = [];
  // Claude Code records the launch in the parent before the child's own
  // file exists. A launch without a transcript yet is looked for again
  // shortly, rather than being missed until the parent next changes.
  // Children whose end the parent does not record (background skills,
  // workflow agents) are looked at again on a timer too.
  let awaiting = false, live = false;
  const root = await realpath(path.join(path.dirname(file), session, "subagents")).catch(() => undefined);
  for (const [agentId, launch] of launches) {
    const childFile = root && await realpath(path.join(root, `agent-${agentId}.jsonl`)).catch(() => undefined);
    if (!childFile || !childFile.startsWith(root + path.sep) || !await claudeChildBelongsTo(childFile, session, agentId)) {
      if (launch.state === "running") awaiting = true;
      continue;
    }
    if (skills.has(agentId) && launch.state === "running") {
      if (await claudeSkillFinished(childFile).catch(() => false)) launch.state = "completed"; else live = true;
    }
    const model = await claudeChildModel(childFile).catch(() => undefined);
    const checkout = await claudeChildCheckout(childFile).catch(() => ({}));
    relations.push({ id: createHash("sha256").update(`claude\0${session}\0${agentId}`).digest("hex").slice(0, 32),
      session: agentId, transcript: childFile, provider: "claude", ...launch,
      ...(model !== undefined ? { model } : {}), ...checkout, children: [] });
  }
  if (teammates.size && root) {
    const entries = await readdir(root).catch(() => [] as string[]);
    const names = entries.filter(n => /^agent-a[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[0-9a-f]{8,32}\.jsonl$/.test(n));
    // Claude Code 2.1.2xx names a teammate's file by id and keeps its name in
    // the `.meta.json` beside it.
    let named: Map<string, string> | undefined;
    for (const [name, launch] of teammates) {
      let fileName = names.find(n => n.startsWith(`agent-a${name}-`));
      if (!fileName) {
        named ??= await claudeChildNames(root, entries);
        fileName = named.get(name);
      }
      const agentId = fileName?.slice("agent-".length, -".jsonl".length);
      // A named agent launched in the background is already listed by its launch.
      if (agentId && launches.has(agentId)) continue;
      const childFile = agentId && await realpath(path.join(root, fileName!)).catch(() => undefined);
      if (!agentId || !childFile || !childFile.startsWith(root + path.sep) || !await claudeChildBelongsTo(childFile, session, agentId)) {
        if (launch.state === "running") awaiting = true;
        continue;
      }
      // The meta file names the model as the launcher chose it ("sonnet");
      // the transcript's first assistant turn carries the full id and wins.
      const meta = await readFile(childFile.slice(0, -".jsonl".length) + ".meta.json", "utf8").then(v => object(JSON.parse(v))).catch(() => ({} as Json));
      const model = await claudeChildModel(childFile).catch(() => undefined) ?? (typeof meta.model === "string" && meta.model ? meta.model.slice(0, 200) : undefined);
      const checkout = await claudeChildCheckout(childFile).catch(() => ({}));
      relations.push({ id: createHash("sha256").update(`claude\0${session}\0${agentId}`).digest("hex").slice(0, 32),
        session: agentId, transcript: childFile, provider: "claude", ...launch,
        ...(model !== undefined ? { model } : {}), ...checkout, children: [] });
    }
  }
  if (workflows.size && root) {
    const seen = new Set(relations.map(relation => relation.session));
    for (const workflow of workflows.values()) {
      for (const child of await claudeWorkflowAgents(root, session, workflow)) {
        if (seen.has(child.session!)) continue;
        seen.add(child.session!); relations.push(child);
        if (child.state === "running") live = true;
      }
    }
  }
  claudeRelationCache.set(file, { signature, relations, ...(awaiting || live ? { recheckAt: Date.now() + (awaiting ? 2_000 : 5_000), rows: kept } : {}) });
  while (claudeRelationCache.size > 64) claudeRelationCache.delete(claudeRelationCache.keys().next().value!);
  return relations;
}

/** How long a background skill's transcript may sit unchanged before it is
 * taken as finished: the parent records no end for it, and a session that
 * exited mid-skill leaves it without a final reply. */
export const CLAUDE_SKILL_QUIET_MS = 30 * 60 * 1000;

/** A background skill is done once its transcript ends on a finished reply,
 * or has not changed for CLAUDE_SKILL_QUIET_MS. */
async function claudeSkillFinished(file: string, now = Date.now()): Promise<boolean> {
  const metadata = await stat(file);
  if (now - metadata.mtimeMs >= CLAUDE_SKILL_QUIET_MS) return true;
  const start = Math.max(0, metadata.size - 65_536), chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file, { start })) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const last = Buffer.concat(chunks).toString("utf8").split("\n").filter(line => line.trim()).at(-1);
  try {
    const raw = object(JSON.parse(last ?? ""));
    return raw.type === "assistant" && object(raw.message).stop_reason === "end_turn";
  } catch { return false; }
}

/** Sub-agent files by the name their `.meta.json` gives them. */
async function claudeChildNames(root: string, entries: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const entry of entries) {
    if (!/^agent-[A-Za-z0-9._-]{1,128}\.meta\.json$/.test(entry)) continue;
    const meta = await readFile(path.join(root, entry), "utf8").then(v => object(JSON.parse(v))).catch(() => ({} as Json));
    if (typeof meta.name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(meta.name)) names.set(meta.name, entry.slice(0, -".meta.json".length) + ".jsonl");
  }
  return names;
}

/** A Workflow run's agents from its journal: each `started` agent runs until
 * the journal records another row for it or the run itself finishes. */
async function claudeWorkflowAgents(root: string, session: string, workflow: { runId: string; name: string; callId: string; state: "running" | "completed" }): Promise<ChildAgentRelation[]> {
  const directory = await realpath(path.join(root, "workflows", workflow.runId)).catch(() => undefined);
  if (!directory || !directory.startsWith(root + path.sep)) return [];
  const journal = path.join(directory, "journal.jsonl");
  const info = await stat(journal).catch(() => undefined);
  if (!info?.isFile() || info.size > 16 * 1024 * 1024) return [];
  const agents = new Map<string, boolean>();
  for (const line of (await readFile(journal, "utf8")).split("\n")) {
    try {
      const row = object(JSON.parse(line)), id = String(row.agentId ?? "");
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) continue;
      agents.set(id, row.type === "started" ? agents.get(id) ?? false : true);
    } catch { /* A row still being written. */ }
  }
  const relations: ChildAgentRelation[] = [];
  for (const [agentId, done] of agents) {
    const childFile = await realpath(path.join(directory, `agent-${agentId}.jsonl`)).catch(() => undefined);
    if (!childFile || !childFile.startsWith(directory + path.sep) || !await claudeChildBelongsTo(childFile, session, agentId)) continue;
    const meta = await readFile(childFile.slice(0, -".jsonl".length) + ".meta.json", "utf8").then(v => object(JSON.parse(v))).catch(() => ({} as Json));
    const model = await claudeChildModel(childFile).catch(() => undefined);
    const checkout = await claudeChildCheckout(childFile).catch(() => ({}));
    relations.push({ id: createHash("sha256").update(`claude\0${session}\0${agentId}`).digest("hex").slice(0, 32),
      session: agentId, transcript: childFile, provider: "claude",
      path: String(meta.description || workflow.name).slice(0, 200), callId: workflow.callId || `workflow:${workflow.runId}`,
      state: done || workflow.state === "completed" ? "completed" : "running",
      ...(model !== undefined ? { model } : {}), ...checkout, children: [] });
  }
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

// `effort` rides on each assistant row (Claude Code 2.1): with `message.model`
// it is what the phone's model chip shows as in effect. `permissionMode` on a
// user row is the mode that turn ran in (the phone's permission chip).
const CLAUDE_KEYS = new Set(["type", "uuid", "parentUuid", "timestamp", "message", "gitBranch", "cwd", "requestId", "isMeta", "isSidechain", "isCompactSummary", "phrenQueued", "phrenQueueKey", "phrenBackground", "phrenCompacted", "effort", "permissionMode"]);

/** State one newest-first pass over a Claude transcript keeps so a
 * content-free `dequeue` can name the prompt turn it delivered: the queue key
 * of that turn and whether the agent's own schedule (a cron, /loop or
 * ScheduleWakeup fire, or an auto-continuation) injected it. */
export interface ClaudeQueueState { key?: string; scheduled?: boolean }

/** The `phrenQueueKey` of the prompt turn a queued message was delivered as:
 * the same SHA-256 of the unwrapped content the enqueue row exports. Undefined
 * for a tool result, a harness envelope, or a turn that is not the person's. */
function queuePromptKey(raw: Json): string | undefined {
  if (raw.type !== "user" || raw.isSidechain === true) return undefined;
  const content = object(raw.message).content;
  const text = unwrapPastedContent(typeof content === "string" ? content
    : objects(content).filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n"));
  if (!text.trim() || text.trimStart().startsWith("<")) return undefined;
  return createHash("sha256").update(text).digest("hex");
}

/** A prompt the agent scheduled for itself, which Claude Code delivers as a
 * hidden user turn (`isMeta`). Auto-continuation names its origin rather than
 * a task id. */
function scheduledPromptTurn(raw: Json): boolean {
  return raw.turnOrigin === "scheduled" || typeof raw.scheduledTaskId === "string"
    || object(raw.origin).kind === "auto-continuation";
}
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

/** The largest injection the phone is sent; the hook's own budget keeps real ones far smaller. */
const HOOK_CONTEXT_LIMIT = 16_384;

const SKILL_BODY = "Base directory for this skill:";
/** What a Skill call loaded. Claude Code answers the call itself with only
 * "Launching skill: <name>" and writes the skill's text as a hidden user row
 * pointing back at the call (`sourceToolUseID`). That row alone crosses, as a
 * second result for the same call, so the phone can show what the skill said;
 * every other hidden row stays private. */
export function skillBody(raw: Json): Json | undefined {
  if (raw.type !== "user" || raw.isMeta !== true || raw.isSidechain || typeof raw.sourceToolUseID !== "string" || !raw.sourceToolUseID) return undefined;
  const content = object(raw.message).content;
  const text = typeof content === "string" ? content
    : objects(content).filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n");
  if (!text.startsWith(SKILL_BODY)) return undefined;
  return { type: "user", timestamp: raw.timestamp, ...(typeof raw.uuid === "string" ? { uuid: raw.uuid } : {}),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: raw.sourceToolUseID, content: text.slice(0, 32_768), phrenSkillBody: true }] } };
}

/** Claude Code's label where a pasted picture path was, and the footer the
 * phone puts above the paths of the files it attached. */
const QUEUED_IMAGE_LABEL = /\[Image #\d+\]/;
const QUEUED_IMAGE_LABELS = /\[Image #\d+\]/g;
const ATTACHED_FILES_FOOTER = /Attached files on this computer:\s*$/;

/** A phren UserPromptSubmit injection, as `{ type: "phren_hook_context",
 * parentUuid, content }`, or undefined for any other row. */
export function phrenHookContext(raw: Json, includeSidechain = false): Json | undefined {
  if (raw.type !== "attachment" || (raw.isSidechain && !includeSidechain)) return undefined;
  const attachment = object(raw.attachment);
  // Input Claude takes mid-turn arrives as a queued_command row right before
  // its hook output. Only whether it was a background notification crosses,
  // so the phone can leave a notification's injection out.
  if (attachment.type === "queued_command") {
    return { type: "phren_turn_input", timestamp: raw.timestamp, notification: attachment.commandMode === "task-notification" };
  }
  if (attachment.type !== "hook_success" || attachment.hookEvent !== "UserPromptSubmit") return undefined;
  const content = typeof attachment.content === "string" ? attachment.content : "";
  if (!/^\s*◆ phren\b/.test(content) && !content.includes("<phren-context>")) return undefined;
  return { type: "phren_hook_context", timestamp: raw.timestamp, uuid: raw.uuid, parentUuid: raw.parentUuid,
    content: content.length > HOOK_CONTEXT_LIMIT ? content.slice(0, HOOK_CONTEXT_LIMIT) + "\n…" : content };
}

/** Claude Code rows the phone may see: user, assistant and system turns with
 * private reasoning redacted, queued phone messages, background task
 * notifications and compaction markers. */
export function visibleClaudeEvent(raw: Json, includeSidechain = false, queue?: ClaudeQueueState): Json | undefined {
  // A follow-up the phone sent a Claude fan-out worker, written into its
  // event log by the Hook before the resumed run.
  if (raw.type === "phren/fanout-message" && typeof raw.text === "string") {
    return { type: "user", timestamp: raw.timestamp, message: { role: "user", content: raw.text.slice(0, 65_536) } };
  }
  // A queued phone message carries the same wrapper; unwrap before the
  // digest so enqueue and remove keep matching keys.
  if (raw.type === "queue-operation" && typeof raw.content === "string") raw = { ...raw, content: unwrapPastedContent(raw.content) };
  // A dequeue is the queue head handed to a turn. Unlike `remove` it carries
  // no content, so its consumption is keyed by the prompt turn it delivered
  // (a newest-first read sees that turn first) and flagged when the agent's
  // own schedule fired it.
  if (raw.type === "queue-operation" && raw.operation === "dequeue") {
    const key = queue?.key, scheduled = queue?.scheduled;
    // One prompt turn answers one dequeue: an older dequeue must not reuse
    // this key and mark a different queued message consumed.
    if (queue) { queue.key = undefined; queue.scheduled = undefined; }
    return { type: "phren_queue_consumed", ...(key ? { key } : {}), ...(key && scheduled ? { scheduled: true } : {}), timestamp: raw.timestamp };
  }
  // popAll pulls queued prompts back into the input: they were neither
  // consumed nor scheduled, so the phone must not draw the leftovers as a
  // "Scheduled check" after the next reply.
  if (raw.type === "queue-operation" && raw.operation === "popAll" && typeof raw.content === "string") {
    return { type: "phren_queue_returned", key: createHash("sha256").update(raw.content).digest("hex"), timestamp: raw.timestamp };
  }
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
    // A picture sent mid-turn queues as "[Image #7]Attached files on this
    // computer:": the pixels never reach this row. Words-free, it matched no
    // receipt, and the phone warned "Not confirmed in chat" about a picture
    // the agent had taken. Name it the way a picture-only turn reads.
    const pictureOnly = QUEUED_IMAGE_LABEL.test(text) && !text.replace(QUEUED_IMAGE_LABELS, "").replace(ATTACHED_FILES_FOOTER, "").trim();
    return { type: "user", phrenQueued: true, phrenQueueKey: key, timestamp: raw.timestamp,
      message: { role: "user", content: pictureOnly ? "[Image attachment]" : text } };
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
  // What phren's prompt hook injected into a user turn: Claude Code records
  // the hook's output as an attachment row pointing at that turn. Only
  // phren's own output crosses; other hooks' output stays private.
  const hookContext = phrenHookContext(raw, includeSidechain);
  if (hookContext) return hookContext;
  const skill = skillBody(raw);
  if (skill) return skill;
  // The row Claude writes when the permission mode changes; nothing else of it.
  if (raw.type === "permission-mode" && typeof raw.permissionMode === "string" && /^[A-Za-z]{1,30}$/.test(raw.permissionMode)) {
    return { type: "permission-mode", permissionMode: raw.permissionMode, ...(typeof raw.timestamp === "string" ? { timestamp: raw.timestamp } : {}) };
  }
  // Remember the prompt turn a queued message was delivered as, so the
  // content-free dequeue written before it can be keyed and flagged scheduled.
  if (queue && raw.type === "user") {
    const key = queuePromptKey(raw);
    if (key !== undefined) { queue.key = key; queue.scheduled = scheduledPromptTurn(raw); }
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
