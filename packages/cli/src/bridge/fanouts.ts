import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type Json, object, type Provider, sessionId } from "./protocol.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_EVENT_LOG_BYTES = 64 * 1024 * 1024;
const MAX_JOBS = 128;
const WORKTREE_CACHE_MS = 15_000;
const exec = promisify(execFile);
const jobID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const timestamp = z.string().datetime({ offset: true });

const opencodeSession = z.string().regex(/^ses_[0-9A-Za-z]{1,64}$/);

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: jobID,
  parent: z.object({ provider: z.enum(["codex", "claude", "copilot", "phren", "opencode"]), session: sessionId }).optional(),
  provider: z.enum(["opencode", "codex"]),
  session: sessionId.optional(),
  taskLabel: z.string().min(1).max(200),
  cwd: z.string().min(1).max(4096).refine(path.isAbsolute),
  worktree: z.string().min(1).max(4096).refine(path.isAbsolute),
  model: z.string().min(1).max(200),
  eventLog: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jsonl$/),
  createdAt: timestamp,
  startedAt: timestamp,
  updatedAt: timestamp,
  finishedAt: timestamp.optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  exitCode: z.number().int().min(0).max(255).optional(),
}).strict().superRefine((manifest, ctx) => {
  // OpenCode sessions are `ses_…`, Codex sessions are thread UUIDs. Neither
  // provider may claim the other's identity.
  if (manifest.session === undefined) return;
  const valid = manifest.provider === "codex" ? z.string().uuid().safeParse(manifest.session).success
    : opencodeSession.safeParse(manifest.session).success;
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["session"],
    message: `A ${manifest.provider} manifest needs a matching session identity.` });
});

export type FanoutManifest = z.infer<typeof manifestSchema>;
export interface FanoutChild {
  /** Parent-scoped opaque ID. Filesystem paths never cross the bridge. */
  id: string;
  provider: "opencode" | "codex";
  session?: string;
  /** The model that manifest named, so the phone can label the worker. */
  model?: string;
  worktreeName?: string;
  branch?: string;
  /** The worker's own checkout, kept off the wire. */
  cwd: string;
  path: string;
  callId: string;
  state: "running" | "completed";
  transcript: string;
  children: FanoutChild[];
}

type WorktreeDetails = Pick<FanoutChild, "worktreeName" | "branch">;
const worktreeCache = new Map<string, { expiresAt: number; details: WorktreeDetails }>();

async function worktreeDetails(worktree: string): Promise<WorktreeDetails> {
  const now = Date.now(), cached = worktreeCache.get(worktree);
  if (cached && cached.expiresAt > now) return cached.details;
  let details: WorktreeDetails = {};
  const metadata = await stat(worktree).catch(() => undefined);
  if (metadata?.isDirectory()) {
    const worktreeName = path.basename(worktree).slice(0, 200);
    details = worktreeName ? { worktreeName } : {};
    try {
      const { stdout } = await exec("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"],
        { timeout: 2_000, maxBuffer: 4_096 });
      const branch = stdout.trim();
      if (branch && branch !== "HEAD") details.branch = branch.slice(0, 200);
    } catch { /* Missing repositories, detached heads, and git errors have no public branch. */ }
  }
  worktreeCache.set(worktree, { expiresAt: Date.now() + WORKTREE_CACHE_MS, details });
  while (worktreeCache.size > MAX_JOBS) worktreeCache.delete(worktreeCache.keys().next().value!);
  return details;
}

export function fanoutRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PHREN_PATH?.trim();
  const store = !configured ? path.join(homedir(), ".phren")
    : configured === "~" ? homedir() : configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : path.resolve(configured);
  return path.join(store, ".runtime", "agent-fanouts");
}

async function regularContainedFile(root: string, candidate: string, maxBytes: number): Promise<string | undefined> {
  try {
    const link = await lstat(candidate);
    if (!link.isFile() || link.isSymbolicLink() || link.size > maxBytes) return;
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(root + path.sep)) return;
    const metadata = await stat(resolved);
    return metadata.isFile() && metadata.size <= maxBytes ? resolved : undefined;
  } catch { return; }
}

/** Read only manifests explicitly bound to the already validated parent. */
export async function fanoutChildren(parentProvider: Provider, parentSession: string, env: NodeJS.ProcessEnv = process.env): Promise<FanoutChild[]> {
  if (!sessionId.safeParse(parentSession).success) return [];
  const configured = fanoutRoot(env);
  let root: string;
  try { root = await realpath(configured); } catch { return []; }
  const names = (await readdir(root).catch(() => [])).filter(name => jobID.safeParse(name).success).slice(0, MAX_JOBS);
  const children: FanoutChild[] = [];
  for (const name of names) {
    const directory = path.join(root, name);
    const manifestFile = await regularContainedFile(root, path.join(directory, "manifest.json"), MAX_MANIFEST_BYTES);
    if (!manifestFile) continue;
    try {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
      if (manifest.id !== name || manifest.parent?.provider !== parentProvider || manifest.parent.session !== parentSession) continue;
      const jobRoot = await realpath(directory);
      if (!jobRoot.startsWith(root + path.sep)) continue;
      const transcript = await regularContainedFile(jobRoot, path.join(jobRoot, manifest.eventLog), MAX_EVENT_LOG_BYTES);
      if (!transcript) continue;
      const worktree = await worktreeDetails(manifest.worktree);
      const id = createHash("sha256").update(`${parentProvider}\0${parentSession}\0${manifest.id}`).digest("hex").slice(0, 32);
      children.push({ id, provider: manifest.provider, session: manifest.session, model: manifest.model, ...worktree, cwd: manifest.worktree,
        path: manifest.taskLabel, callId: `fanout:${id}`, state: ["queued", "running"].includes(manifest.status) ? "running" : "completed",
        transcript, children: [] });
    } catch { /* Torn, old, or untrusted manifests do not become child agents. */ }
  }
  return children.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
}

/** Project raw `opencode run --format json` rows into the small public chat
 * contract. Reasoning, snapshots, costs, and metadata are omitted. Like the
 * Codex mapping, the command, URL or path a tool was given and a bounded
 * output tail cross the wire so the owner can see what a worker is doing;
 * file contents being written and full arguments of other tools do not. */
export function visibleOpenCodeRunEvent(raw: Json): Json | undefined {
  const part = object(raw.part), time = typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)
    ? new Date(raw.timestamp).toISOString() : undefined;
  if (raw.type === "text" && part.type === "text" && typeof part.text === "string") {
    return { type: "assistant/message", ...(time ? { time } : {}), data: { message: {
      role: "assistant", content: [{ type: "text", text: part.text.slice(0, 262_144) }],
    } } };
  }
  if (raw.type === "tool_use" && part.type === "tool" && typeof part.tool === "string") {
    const state = object(part.state), status = ["pending", "running", "completed", "error"].includes(String(state.status))
      ? String(state.status) : "completed";
    const id = String(part.callID ?? "").slice(0, 200);
    const content: Json[] = [{ type: "tool_use", id, name: part.tool.slice(0, 200), input: opencodeToolInput(part.tool, object(state.input)), phrenStatus: status }];
    if (status === "completed" || status === "error") {
      content.push({ type: "tool_result", tool_use_id: id, content: opencodeToolOutput(part.tool, state), ...(status === "error" ? { is_error: true } : {}) });
    }
    return { type: "assistant/message", ...(time ? { time } : {}), data: { message: { role: "assistant", content } } };
  }
  if (raw.type === "step_finish") {
    return { type: "system", ...(time ? { time } : {}), data: { message: {
      role: "assistant", content: [{ type: "text", text: `Step finished${typeof part.reason === "string" ? `: ${part.reason.slice(0, 200)}` : "."}` }],
    } } };
  }
}

/** Project raw `codex exec --json` rows into the shape Codex's own rollout
 * files use, so the existing Codex transcript reader renders them unchanged.
 * Command text, a bounded output tail, and changed paths cross the wire so the
 * owner can see what a worker is doing; diffs, usage, and costs do not. */
export function visibleCodexExecEvent(raw: Json): Json | undefined {
  const item = object(raw.item), callId = () => String(item.id ?? "").slice(0, 200);
  if (raw.type === "item.completed" && item.type === "agent_message") {
    if (typeof item.text !== "string") return undefined;
    return { type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: item.text.slice(0, 262_144) }] } };
  }
  if (raw.type === "item.started" && item.type === "command_execution") {
    return { type: "response_item", payload: { type: "function_call", name: "shell",
      call_id: callId(), arguments: JSON.stringify({ command: codexCommand(item) }) } };
  }
  if (raw.type === "item.completed" && item.type === "command_execution") {
    return { type: "response_item", payload: { type: "function_call_output", call_id: callId(),
      output: codexCommandOutput(item) } };
  }
  if (raw.type === "item.started" && item.type === "file_change") {
    return { type: "response_item", payload: { type: "function_call", name: "apply_patch",
      call_id: callId(), arguments: JSON.stringify({ files: codexFiles(item) }) } };
  }
  if (raw.type === "item.completed" && item.type === "file_change") {
    const files = codexFiles(item), header = `${files.length} file(s) changed`;
    return { type: "response_item", payload: { type: "function_call_output", call_id: callId(),
      output: files.length ? `${header}\n${files.map(file => file.path).join("\n")}` : header } };
  }
  if (raw.type === "turn.completed") return { type: "event_msg", payload: { type: "task_complete" } };
  if (raw.type === "error" && typeof raw.message === "string") {
    return { type: "event_msg", payload: { type: "error", message: raw.message.slice(0, 2000) } };
  }
  return undefined;
}

/** The one argument that says what a tool did: a command, a URL, a path or a
 * pattern. Everything else (file contents, headers, MCP payloads) stays home. */
function opencodeToolInput(tool: string, input: Json): Json {
  const text = (key: string, max = 2000) => typeof input[key] === "string" ? collapseHomeText(String(input[key])).slice(0, max) : undefined;
  switch (tool) {
    case "bash": return { command: text("command") ?? "" };
    case "webfetch": return { url: text("url") ?? "" };
    case "read": case "edit": case "write": case "patch": return { path: text("filePath") ?? text("path") ?? "" };
    case "grep": case "glob": case "list": return { pattern: text("pattern", 500) ?? "", path: text("path") ?? "" };
    default: return {};
  }
}

function opencodeToolOutput(tool: string, state: Json): string {
  const metadata = object(state.metadata);
  const raw = typeof state.output === "string" ? state.output : typeof state.error === "string" ? state.error : "";
  const text = collapseHomeText(raw).slice(-4000);
  if (tool === "bash") return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${typeof metadata.exit === "number" ? `[exit ${metadata.exit}]` : "[finished]"}`;
  return text;
}

/** Replace the real home directory wherever it appears in free text (a
 * command line, an output tail) with `~`, so the account name stays home. */
function collapseHomeText(value: string): string {
  const home = homedir();
  const base = home.endsWith(path.sep) ? home.slice(0, -path.sep.length) : home;
  return base.length > 1 ? value.split(base).join("~") : value;
}

/** Replace a leading real home directory with `~` for display. */
function collapseHome(value: string): string {
  const home = homedir();
  const trimmed = home.endsWith(path.sep) ? home.slice(0, -path.sep.length) : home;
  for (const base of [home, trimmed]) {
    if (value === base) return "~";
    const prefix = `${base}${path.sep}`;
    if (value.startsWith(prefix)) return `~${path.sep}${value.slice(prefix.length)}`;
  }
  return value;
}

function codexCommand(item: Json): string {
  const value = item.command;
  const text = Array.isArray(value) ? value.filter(part => typeof part === "string").join(" ")
    : typeof value === "string" ? value : "";
  return text.slice(0, 2000);
}

function codexCommandOutput(item: Json): string {
  const text = typeof item.aggregated_output === "string" ? item.aggregated_output.slice(-4000) : "";
  const status = typeof item.exit_code === "number" ? `[exit ${item.exit_code}]` : "[finished]";
  return `${text}\n${status}`;
}

function codexFiles(item: Json): Array<{ path: string; kind: string }> {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.slice(0, 50).map(change => {
    const entry = object(change);
    return { path: collapseHome(String(entry.path ?? "")).slice(0, 512), kind: String(entry.kind ?? "").slice(0, 512) };
  });
}
