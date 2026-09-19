import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { type Json, object, type Provider, sessionId } from "./protocol.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_EVENT_LOG_BYTES = 64 * 1024 * 1024;
const MAX_JOBS = 128;
const jobID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const timestamp = z.string().datetime({ offset: true });

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: jobID,
  parent: z.object({ provider: z.enum(["codex", "claude", "copilot", "phren", "opencode"]), session: sessionId }).optional(),
  provider: z.literal("opencode"),
  session: z.string().regex(/^ses_[0-9A-Za-z]{1,64}$/).optional(),
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
}).strict();

export type FanoutManifest = z.infer<typeof manifestSchema>;
export interface FanoutChild {
  /** Parent-scoped opaque ID. Filesystem paths never cross the bridge. */
  id: string;
  provider: "opencode";
  session?: string;
  path: string;
  callId: string;
  state: "running" | "completed";
  transcript: string;
  children: FanoutChild[];
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
      const id = createHash("sha256").update(`${parentProvider}\0${parentSession}\0${manifest.id}`).digest("hex").slice(0, 32);
      children.push({ id, provider: "opencode", session: manifest.session, path: manifest.taskLabel,
        callId: `fanout:${id}`, state: ["queued", "running"].includes(manifest.status) ? "running" : "completed",
        transcript, children: [] });
    } catch { /* Torn, old, or untrusted manifests do not become child agents. */ }
  }
  return children.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
}

/** Project raw `opencode run --format json` rows into the small public chat
 * contract. Reasoning, tool inputs/outputs, snapshots, costs, and metadata are
 * intentionally omitted. */
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
    return { type: "assistant/message", ...(time ? { time } : {}), data: { message: {
      role: "assistant", content: [{ type: "tool_use", id: String(part.callID ?? "").slice(0, 200),
        name: part.tool.slice(0, 200), input: {}, phrenStatus: status }],
    } } };
  }
  if (raw.type === "step_finish") {
    return { type: "system", ...(time ? { time } : {}), data: { message: {
      role: "assistant", content: [{ type: "text", text: `Step finished${typeof part.reason === "string" ? `: ${part.reason.slice(0, 200)}` : "."}` }],
    } } };
  }
}
