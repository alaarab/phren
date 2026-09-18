import { request, createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile, readFile, rename, chmod, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError, bridgeRoot, object, objects, provider, serverName, sessionId, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { herdrRoot, rpc, snapshot, trustedDirectory, validateTarget } from "./herdr.js";
import { capturesChanges, ToolChanges } from "./changes.js";

const localSocket = () => path.join(bridgeRoot(), "agent.sock");
const bindingPath = (server: string, pane: string) => path.join(bridgeRoot(), "bindings", encodeURIComponent(serverName.parse(server)), encodeURIComponent(pane) + ".json");
export async function recordedSession(server: string, pane: Json, pids: number[]): Promise<string | undefined> {
  try {
    const value = object(JSON.parse(await readFile(bindingPath(server, String(pane.pane_id)), "utf8")));
    if (value.terminal !== pane.terminal_id || value.source !== pane.agent || !Array.isArray(value.pids) || !value.pids.some(p => pids.includes(Number(p)))) return undefined;
    return sessionId.parse(value.session);
  } catch { return undefined; }
}

interface Pending { target: Target; response: ServerResponse; tool: string; input: unknown; message: string; expiresAt: string; timer: NodeJS.Timeout }

/** Claude Code's AskUserQuestion is answered by allowing the call with its own
 * input plus `answers` keyed by question text (a label, or labels when the
 * question is multiSelect; any other string is a typed "Other"). The phone may
 * add answers and a free-text `response`; it may not rewrite the questions. */
const questionAnswers = z.looseObject({
  answers: z.record(z.string().min(1).max(4000), z.union([z.string().max(4000), z.array(z.string().max(4000)).min(1).max(24)])).refine(a => Object.keys(a).length > 0),
  response: z.string().max(4000).optional(),
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value as Json).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Json)[k])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export function answeredQuestionInput(tool: string, input: unknown, updatedInput: unknown): Json {
  if (tool !== "AskUserQuestion") throw new BridgeError(400, "Only a question can be answered with input.");
  if (updatedInput === null || typeof updatedInput !== "object" || Array.isArray(updatedInput)) throw new BridgeError(400, "The answer is not an object.");
  const raw = JSON.stringify(updatedInput);
  if (Buffer.byteLength(raw) > 32_768) throw new BridgeError(400, "The answer is too large.");
  const parsed = questionAnswers.safeParse(updatedInput);
  if (!parsed.success) throw new BridgeError(400, "The answer must add an answers object.");
  const { answers, response, ...rest } = parsed.data;
  if (canonical(rest) !== canonical(object(input))) throw new BridgeError(400, "The answer must keep the original questions.");
  const asked = new Set(objects(object(input).questions).map(q => q.question).filter(q => typeof q === "string"));
  if (Object.keys(answers).some(q => !asked.has(q))) throw new BridgeError(400, "The answer names a question that was not asked.");
  return { ...object(input), answers, ...(response === undefined ? {} : { response }) };
}

/** An explicit foreground overview poll renews interest for a bounded interval.
 * A disconnected phone never leaves future terminal prompts waiting forever. */
export class ApprovalWatchLeases {
  private servers = new Map<string, number>();
  constructor(private now = Date.now) {}
  renew(server: string) {
    for (const [key, expiry] of this.servers) if (expiry <= this.now()) this.servers.delete(key);
    if (this.servers.has(server) || this.servers.size < 64) this.servers.set(server, this.now() + 25_000);
  }
  has(server: string) { return (this.servers.get(server) || 0) > this.now(); }
}
/** This socket is deliberately separate from the phone's HTTP pipe. Only local
 * agent callbacks can register identities or create an approval request. */
export class AgentHooks {
  readonly changes = new ToolChanges();
  private pending = new Map<string, Pending>();
  private watching = new Map<string, number>();
  readonly overview = new ApprovalWatchLeases();
  private server?: Server;
  watch(target: Target): () => void {
    const key = JSON.stringify(target);
    this.watching.set(key, (this.watching.get(key) || 0) + 1);
    return () => { const n = (this.watching.get(key) || 1) - 1; if (n) this.watching.set(key, n); else this.watching.delete(key); };
  }
  approval(target: Target): Json | undefined {
    const pending = [...this.pending.entries()].find(([, p]) => JSON.stringify(p.target) === JSON.stringify(target));
    return pending ? { actionId: pending[0], toolName: pending[1].tool, title: `Allow ${pending[1].tool}?`, message: pending[1].message, expiresAt: pending[1].expiresAt } : undefined;
  }
  pendingPanes(server: string, state: Json): Set<string> {
    const panes = objects(state.panes);
    return new Set([...this.pending.values()].filter(p => p.target.server === server && panes.some(pane => {
      if (pane.pane_id !== p.target.pane || pane.workspace_id !== p.target.workspace || pane.tab_id !== p.target.tab || pane.agent !== p.target.source) return false;
      const reported = object(pane.agent_session);
      return reported.kind !== "id" || (reported.agent === p.target.source && reported.value === p.target.session);
    })).map(p => p.target.pane));
  }
  async answer(target: Target, id: string, decision: unknown, updatedInput?: unknown) {
    const entry = this.pending.get(id);
    if (!entry || JSON.stringify(entry.target) !== JSON.stringify(target) || !["approve", "deny"].includes(String(decision))) throw new BridgeError(409, "This approval is no longer pending.");
    if (updatedInput !== undefined && decision !== "approve") throw new BridgeError(400, "Answers go with an approval.");
    const answered = updatedInput === undefined ? undefined : answeredQuestionInput(entry.tool, entry.input, updatedInput);
    await validateTarget(target);
    if (this.pending.get(id) !== entry || entry.response.destroyed) throw new BridgeError(409, "This approval is no longer pending.");
    this.pending.delete(id); clearTimeout(entry.timer);
    entry.response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {
      behavior: decision === "approve" ? "allow" : "deny", ...(decision === "deny" ? { message: "Declined in Phren." } : {}),
      ...(answered ? { updatedInput: answered } : {}),
    } } }));
  }
  async start() {
    // The public helper singleton was already checked before this is called.
    const previous = await lstat(localSocket()).catch(() => undefined);
    if (previous) {
      if (!previous.isSocket() || previous.uid !== process.getuid?.()) throw new Error("Unexpected agent callback socket.");
      await unlink(localSocket());
    }
    this.server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      try {
        if (req.method !== "POST" || req.url !== "/hook") throw new Error("Invalid callback");
        let size = 0; const chunks: Buffer[] = [];
        for await (const bytes of req) { size += bytes.length; if (size > 1_048_576) throw new Error("Oversized hook"); chunks.push(bytes); }
        const body = object(JSON.parse(Buffer.concat(chunks).toString())), target = targetSchema.parse(body.target);
        const s = await snapshot(target.server);
        const pane = objects(s.panes).find(p => p.pane_id === target.pane && p.tab_id === target.tab && p.workspace_id === target.workspace);
        if (!pane || (pane.agent && pane.agent !== target.source)) throw new Error("The pane changed");
        const info = object((await rpc(target.server, "pane.process_info", { pane_id: target.pane })).process_info);
        const pids = objects(info.foreground_processes).map(p => p.pid).filter(p => Number.isSafeInteger(p));
        if (!pids.length) throw new Error("No foreground process");
        const file = bindingPath(target.server, target.pane); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = file + "." + randomUUID();
        await writeFile(temporary, JSON.stringify({ terminal: pane.terminal_id, source: target.source, session: target.session, pids }), { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
        // What a shell call changed on disk: snapshot before, diff after.
        const input = typeof body.input === "string" ? { patch: body.input } : object(body.input), command = [input.command, input.cmd].find(v => typeof v === "string") as string | undefined;
        // A shell call by name, or any tool whose input is a command line —
        // Codex has renamed its shell tool more than once.
        if (["PreToolUse", "PostToolUse"].includes(String(body.event)) && capturesChanges(String(body.tool), input)) {
          const conversation = `${target.source}:${target.session}`, id = String(body.toolUseId || "").slice(0, 200);
          if (body.event === "PreToolUse") await this.changes.before(conversation, id, typeof body.cwd === "string" && path.isAbsolute(body.cwd) ? body.cwd : await trustedDirectory(pane), command ?? "", input);
          else await this.changes.after(conversation, id);
          res.end("{}"); return;
        }
        if (body.event !== "PermissionRequest" || target.source === "copilot"
          || (!this.watching.has(JSON.stringify(target)) && !this.overview.has(target.server))) { res.end("{}"); return; }
        // An exact chat watcher or explicit foreground overview lease is needed.
        // Timeouts always return control to the ordinary terminal prompt.
        if (this.pending.size >= 64) { res.end("{}"); return; }
        const action = randomUUID();
        const timer = setTimeout(() => { this.pending.delete(action); res.end("{}"); }, 55_000);
        this.pending.set(action, { target, response: res, tool: String(body.tool || "action").slice(0, 200), input: body.input,
          message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), expiresAt: new Date(Date.now() + 55_000).toISOString(), timer });
        res.on("close", () => { clearTimeout(timer); this.pending.delete(action); });
      } catch { if (!res.headersSent) res.statusCode = 400; res.end("{}"); }
    });
    this.server.requestTimeout = 65_000;
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(localSocket(), () => resolve()); });
    await chmod(localSocket(), 0o600);
  }
  close() {
    void this.changes.close().catch(() => {});
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.response.end("{}"); }
    this.pending.clear(); this.server?.close(); this.server?.closeAllConnections();
  }
}

export async function agentHook(source: Provider) {
  provider.parse(source);
  // A missing helper must never prevent the coding agent from running.
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH) return;
  const socket = path.resolve(process.env.HERDR_SOCKET_PATH), root = path.resolve(herdrRoot());
  const server = socket === path.join(root, "herdr.sock") ? "default"
    : socket.startsWith(path.join(root, "sessions") + path.sep) ? path.basename(path.dirname(socket)) : undefined;
  if (!server) return;
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 1_048_576) return; }
  const value = object(JSON.parse(input));
  if (value.agent_id || value.agentId || value.isSidechain || value.is_sidechain) return;
  const target = targetSchema.parse({ server, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID,
    pane: process.env.HERDR_PANE_ID, source, session: value.session_id || value.sessionId });
  const event = String(value.hook_event_name || "SessionStart");
  const data = JSON.stringify({ target, event, tool: value.tool_name, input: value.tool_input, toolUseId: value.tool_use_id, cwd: value.cwd });
  await new Promise<void>(resolve => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST", timeout: event === "PermissionRequest" ? 58_000 : event.endsWith("ToolUse") ? 8_000 : 1500,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => {
      let result = "";
      res.on("data", chunk => { result += chunk.toString(); if (result.length > 16_384) req.destroy(); });
      res.on("end", () => { if (res.statusCode === 200 && event === "PermissionRequest") process.stdout.write(result); resolve(); });
      res.on("error", () => resolve());
    });
    req.on("error", () => resolve()); req.on("timeout", () => { req.destroy(); resolve(); }); req.end(data);
  });
}
