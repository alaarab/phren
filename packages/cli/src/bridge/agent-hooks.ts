import { request, createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile, readFile, rename, chmod, unlink, lstat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError, bridgeRoot, object, objects, provider, serverName, sessionId, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { herdrRoot, rpc, snapshot, trustedDirectory, validateTarget } from "./herdr.js";
import { capturesChanges, ToolChanges } from "./changes.js";
import { phrenStoreRoot, unwrapPastedContent } from "./transcripts.js";
import { ApprovalPushService } from "./push.js";

const opencodeSession = /^ses_[0-9A-Za-z]{1,64}$/;
function opencodeApprovalFile(session: string, kind: "request" | "answer"): string | undefined {
  if (!opencodeSession.test(session)) return undefined;
  return path.join(phrenStoreRoot(), ".runtime", "approvals", `opencode-${session}.${kind}.json`);
}
function opencodeRequest(session: string): Json | undefined {
  const file = opencodeApprovalFile(session, "request");
  if (!file) return undefined;
  try {
    const value = object(JSON.parse(readFileSync(file, "utf8")));
    if (typeof value.id !== "string" || !value.id || value.sessionID !== session) return undefined;
    if (typeof value.expiresAt === "string" && Date.parse(value.expiresAt) <= Date.now()) return undefined;
    return value;
  } catch { return undefined; }
}

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
interface PushBinding { action: string; expiresAt: number }
export class PushBindingStore {
  private values = new Map<string, PushBinding>();
  constructor(private now = Date.now, private limit = 128) {}
  add(binding: string, value: PushBinding) {
    for (const [key, item] of this.values) if (item.expiresAt <= this.now()) this.values.delete(key);
    while (this.values.size >= this.limit) this.values.delete(this.values.keys().next().value!);
    this.values.set(binding, value);
  }
  consume(binding: string): PushBinding | undefined {
    const value = this.values.get(binding); this.values.delete(binding);
    return value && value.expiresAt > this.now() ? value : undefined;
  }
  dropAction(action: string) { for (const [key, value] of this.values) if (value.action === action) this.values.delete(key); }
  clear() { this.values.clear(); }
  get size() { return this.values.size; }
}

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
export type DeliveryOutcome = "delivered" | "blocked" | "pending";
interface Delivery { source: Provider; session: string; settle: (outcome: DeliveryOutcome) => void; timer: ReturnType<typeof setTimeout> }

/** What the agent hands its UserPromptSubmit hook is the terminal's pasted
 * form of what Phren typed; compare the words, not the wrapping. */
function promptKey(text: string): string {
  return unwrapPastedContent(text).replace(/\s+/g, " ").trim();
}

/** This socket is deliberately separate from the phone's HTTP pipe. Only local
 * agent callbacks can register identities or create an approval request. */
export class AgentHooks {
  readonly changes = new ToolChanges();
  private pending = new Map<string, Pending>();
  /** Prompts Phren has typed into a pane, by their text, until the agent that
   * actually receives one reports in through UserPromptSubmit. Herdr writes
   * to a pane, not a conversation; the receiving agent's hook is the only
   * party that knows which conversation consumed the text, so it is the one
   * that can refuse it when that is not the conversation the phone meant. */
  private deliveries = new Map<string, Delivery[]>();
  /** The permission request a conversation is drawing in its own terminal
   * because nobody was there to hold it: what the phone shows above its
   * answer keys until the pane stops waiting. */
  private terminalPrompts = new Map<string, { tool: string; message: string; at: number }>();
  /** Panes where Phren just typed a bare slash command: the agent is drawing
   * that command's menu, which Herdr reports as an idle agent, so keys are
   * allowed there for a short while to walk and confirm it. */
  private menus = new Map<string, number>();
  private watching = new Map<string, number>();
  readonly overview = new ApprovalWatchLeases();
  private server?: Server;
  private pushBindings = new PushBindingStore();
  constructor(readonly push = new ApprovalPushService()) {}
  watch(target: Target): () => void {
    const key = JSON.stringify(target);
    this.watching.set(key, (this.watching.get(key) || 0) + 1);
    return () => { const n = (this.watching.get(key) || 1) - 1; if (n) this.watching.set(key, n); else this.watching.delete(key); };
  }
  /** Register a prompt about to be typed into `target`'s pane. The returned
   * promise settles "delivered" once that conversation's own hook submits the
   * text, "blocked" if another conversation in the pane tried to, or "pending"
   * after `waitMs`: a busy agent queues typed input and submits it only when
   * its turn ends, so the record outlives the wait (up to ten minutes) and a
   * late submission to the wrong conversation is still refused. */
  expectDelivery(target: Target, text: string, waitMs = 1_500): Promise<DeliveryOutcome> {
    const key = promptKey(text);
    if (!key) return Promise.resolve("pending");
    return new Promise<DeliveryOutcome>(resolve => {
      let settled = false;
      const list = this.deliveries.get(key) ?? [];
      const remove = () => { const current = this.deliveries.get(key) ?? []; const index = current.indexOf(delivery); if (index >= 0) current.splice(index, 1); if (!current.length) this.deliveries.delete(key); };
      const settle = (outcome: DeliveryOutcome) => { if (!settled) { settled = true; resolve(outcome); } if (outcome !== "pending") { clearTimeout(delivery.timer); remove(); } };
      const delivery: Delivery = { source: target.source, session: target.session, settle, timer: setTimeout(() => settle("pending"), waitMs) };
      delivery.timer.unref?.();
      const expiry = setTimeout(remove, 600_000); expiry.unref?.();
      list.push(delivery); this.deliveries.set(key, list);
      while (this.deliveries.size > 256) this.deliveries.delete(this.deliveries.keys().next().value!);
    });
  }
  /** The conversation `target` just submitted `prompt`. Nothing Phren typed
   * matches: a locally typed prompt, always allowed. Otherwise the oldest
   * matching delivery decides: its own conversation consumes it; any other
   * conversation is told to drop it, so the text is never spoken to the
   * wrong agent and the phone can safely send it again. */
  private submitted(target: Target, prompt: string): Json {
    const list = this.deliveries.get(promptKey(prompt));
    const delivery = list?.[0];
    if (!delivery) return {};
    if (delivery.source === target.source && delivery.session === target.session) { delivery.settle("delivered"); return {}; }
    delivery.settle("blocked");
    return { decision: "block", reason: "Phren sent this message to a different conversation in this pane; it was not delivered here. Send it again from the phone." };
  }
  private rememberTerminalPrompt(target: Target, body: Json) {
    this.terminalPrompts.set(JSON.stringify(target), { tool: String(body.tool || "action").slice(0, 200),
      message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), at: Date.now() });
    while (this.terminalPrompts.size > 64) this.terminalPrompts.delete(this.terminalPrompts.keys().next().value!);
  }
  /** The request the agent is showing in its terminal, if one fell through
   * in the last fifteen minutes; the caller only asks while the pane waits. */
  terminalPrompt(target: Target): Json | undefined {
    const key = JSON.stringify(target), entry = this.terminalPrompts.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > 900_000) { this.terminalPrompts.delete(key); return undefined; }
    return { toolName: entry.tool, message: entry.message, at: new Date(entry.at).toISOString() };
  }
  clearTerminalPrompt(target: Target) { this.terminalPrompts.delete(JSON.stringify(target)); }
  menuOpened(target: Target) {
    this.menus.set(JSON.stringify(target), Date.now());
    while (this.menus.size > 64) this.menus.delete(this.menus.keys().next().value!);
  }
  menuOpen(target: Target): boolean {
    const at = this.menus.get(JSON.stringify(target));
    return at !== undefined && Date.now() - at < 30_000;
  }
  menuClosed(target: Target) { this.menus.delete(JSON.stringify(target)); }
  approval(target: Target): Json | undefined {
    const pending = [...this.pending.entries()].find(([, p]) => JSON.stringify(p.target) === JSON.stringify(target));
    if (pending) return { actionId: pending[0], toolName: pending[1].tool, title: `Allow ${pending[1].tool}?`, message: pending[1].message, expiresAt: pending[1].expiresAt };
    if (target.source !== "opencode") return undefined;
    const request = opencodeRequest(target.session);
    return request ? { actionId: request.id, toolName: request.type, title: request.title, message: request.message, expiresAt: request.expiresAt } : undefined;
  }
  pendingPanes(server: string, state: Json): Set<string> {
    const panes = objects(state.panes);
    const pending = new Set([...this.pending.values()].filter(p => p.target.server === server && panes.some(pane => {
      if (pane.pane_id !== p.target.pane || pane.workspace_id !== p.target.workspace || pane.tab_id !== p.target.tab || pane.agent !== p.target.source) return false;
      const reported = object(pane.agent_session);
      return reported.kind !== "id" || (reported.agent === p.target.source && reported.value === p.target.session);
    })).map(p => p.target.pane));
    for (const pane of panes) {
      if (pane.agent !== "opencode") continue;
      const reported = object(pane.agent_session);
      if (reported.kind === "id" && reported.agent === "opencode" && typeof reported.value === "string" && opencodeRequest(reported.value)) {
        pending.add(String(pane.pane_id));
      }
    }
    return pending;
  }
  async answer(target: Target, id: string, decision: unknown, updatedInput?: unknown) {
    if (target.source === "opencode") {
      if (!["approve", "deny"].includes(String(decision))) throw new BridgeError(400, "The approval answer is not valid.");
      const file = opencodeApprovalFile(target.session, "answer");
      if (!file) throw new BridgeError(400, "Invalid conversation identity.");
      await validateTarget(target);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + "." + randomUUID();
      await writeFile(temporary, JSON.stringify({ id, decision }), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
      return;
    }
    const entry = this.pending.get(id);
    if (!entry || JSON.stringify(entry.target) !== JSON.stringify(target) || !["approve", "deny"].includes(String(decision))) throw new BridgeError(409, "This approval is no longer pending.");
    if (updatedInput !== undefined && decision !== "approve") throw new BridgeError(400, "Answers go with an approval.");
    const answered = updatedInput === undefined ? undefined : answeredQuestionInput(entry.tool, entry.input, updatedInput);
    await validateTarget(target);
    if (this.pending.get(id) !== entry || entry.response.destroyed) throw new BridgeError(409, "This approval is no longer pending.");
    this.pending.delete(id); this.dropPushBindings(id); clearTimeout(entry.timer);
    entry.response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {
      behavior: decision === "approve" ? "allow" : "deny", ...(decision === "deny" ? { message: "Declined in Phren." } : {}),
      ...(answered ? { updatedInput: answered } : {}),
    } } }));
  }
  async answerPush(binding: string, decision: unknown) {
    if (!["approve", "deny"].includes(String(decision))) throw new BridgeError(400, "The approval answer is not valid.");
    const linked = this.pushBindings.consume(binding);
    if (!linked) throw new BridgeError(409, "This approval is no longer pending.");
    const pending = this.pending.get(linked.action);
    if (!pending) throw new BridgeError(409, "This approval is no longer pending.");
    await this.answer(pending.target, linked.action, decision);
  }
  private dropPushBindings(action: string) {
    this.pushBindings.dropAction(action);
  }
  async start() {
    await this.push.start();
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
        if (body.event === "UserPromptSubmit") {
          res.end(JSON.stringify(typeof body.prompt === "string" ? this.submitted(target, body.prompt.slice(0, 65_536)) : {})); return;
        }
        if (["PreToolUse", "PostToolUse"].includes(String(body.event)) && capturesChanges(String(body.tool), input)) {
          const conversation = `${target.source}:${target.session}`, id = String(body.toolUseId || "").slice(0, 200);
          if (body.event === "PreToolUse") await this.changes.before(conversation, id, typeof body.cwd === "string" && path.isAbsolute(body.cwd) ? body.cwd : await trustedDirectory(pane), command ?? "", input);
          else await this.changes.after(conversation, id);
          res.end("{}"); return;
        }
        if (body.event === "PermissionRequest") this.terminalPrompts.delete(JSON.stringify(target));
        if (body.event !== "PermissionRequest" || target.source === "copilot"
          || (!this.watching.has(JSON.stringify(target)) && !this.overview.has(target.server) && !this.push.available)) {
          if (body.event === "PermissionRequest") this.rememberTerminalPrompt(target, body);
          res.end("{}"); return;
        }
        // A foreground watcher or configured push device can hold the callback.
        // Timeouts always return control to the ordinary terminal prompt.
        if (this.pending.size >= 64) { res.end("{}"); return; }
        const action = randomUUID();
        const locallyWatched = this.watching.has(JSON.stringify(target)) || this.overview.has(target.server);
        const timer = setTimeout(() => { this.pending.delete(action); this.dropPushBindings(action); this.rememberTerminalPrompt(target, body); res.end("{}"); }, 55_000);
        const expiresAt = new Date(Date.now() + 55_000).toISOString();
        this.pending.set(action, { target, response: res, tool: String(body.tool || "action").slice(0, 200), input: body.input,
          message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), expiresAt, timer });
        res.on("close", () => { clearTimeout(timer); this.pending.delete(action); this.dropPushBindings(action); });
        if (this.push.available) {
          const binding = randomUUID();
          this.pushBindings.add(binding, { action, expiresAt: Date.parse(expiresAt) });
          void this.push.notify({ binding, provider: target.source, question: body.tool === "AskUserQuestion", expiresAt }).then(delivered => {
            if (!delivered) {
              this.pushBindings.consume(binding);
              const pending = this.pending.get(action);
              if (!locallyWatched && pending) { clearTimeout(pending.timer); this.pending.delete(action); res.end("{}"); }
            }
          });
        }
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
    this.pushBindings.clear();
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
  const data = JSON.stringify({ target, event, tool: value.tool_name, input: value.tool_input, toolUseId: value.tool_use_id, cwd: value.cwd,
    ...(event === "UserPromptSubmit" && typeof value.prompt === "string" ? { prompt: value.prompt.slice(0, 65_536) } : {}) });
  await new Promise<void>(resolve => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST", timeout: event === "PermissionRequest" ? 58_000 : event.endsWith("ToolUse") ? 8_000 : 1500,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => {
      let result = "";
      res.on("data", chunk => { result += chunk.toString(); if (result.length > 16_384) req.destroy(); });
      // Only a decision reaches the agent: an approval answer, or a refusal of
      // a prompt Phren meant for another conversation. An empty reply says nothing.
      res.on("end", () => { if (res.statusCode === 200 && (event === "PermissionRequest" || (event === "UserPromptSubmit" && result.includes("\"decision\"")))) process.stdout.write(result); resolve(); });
      res.on("error", () => resolve());
    });
    req.on("error", () => resolve()); req.on("timeout", () => { req.destroy(); resolve(); }); req.end(data);
  });
}
