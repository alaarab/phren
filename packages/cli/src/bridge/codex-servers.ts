import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { type AppServerClient, type AppServerRequestId, AppServerRpcError, type AppServerTurnInput, connectAppServer, type PendingServerRequest, spawnAppServer } from "./codex-app-server.js";
import { logger } from "../logger.js";
import { atomic, bridgeRoot, id, type Json, object, objects, serverName, type Target } from "./protocol.js";

/**
 * Codex panes the Hook launches run on a Phren-owned `codex app-server`, one
 * per pane: the Hook spawns `codex app-server --listen unix://<sock>`, starts
 * the thread itself (`thread/start`), and the pane runs `codex resume
 * <threadId> --remote unix://<sock>` as a second client of that thread. The
 * Hook's own client sends prompts (`turn/start`, acknowledged with a turn id),
 * interrupts (`turn/interrupt`, after declining parked requests) and answers
 * approvals (server requests, no hold timeout); whatever the owner does in the
 * pane reaches the same thread. The registry under
 * `<bridge>/codex-servers/<id>/server.json` lets a restarted Hook find each
 * running server again and reconnect to its thread.
 */

const REGISTRY = "codex-servers";
/** A Unix socket path is limited to about 104 bytes (macOS) / 108 (Linux). */
const MAX_SOCKET_PATH = 100;
/** A pane that shows no Codex for this long no longer runs the worker. */
const AGENT_GONE_MS = 120_000;
const CLIENT_NAME = "phren_hook";
const QUESTION_METHODS = new Set(["item/tool/requestUserInput", "mcpServer/elicitation/request"]);

const entrySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/),
  server: serverName,
  workspace: id,
  tab: id,
  pane: id,
  socket: z.string().min(1).max(4096),
  pid: z.number().int().positive(),
  /** Unknown for a moment after a launch without a brief: the pane's TUI
   * starts the thread itself and the Hook learns it from `thread/started`. */
  threadId: z.string().min(1).max(200).optional(),
  cwd: z.string().min(1).max(4096),
  startedAt: z.string(),
  dispatchId: z.string().optional(),
  activeTurn: z.string().optional(),
  lastTurn: z.object({ id: z.string(), status: z.string(), at: z.string() }).optional(),
  /** What the phone chose, sent with the Hook's next `turn/start` (Codex keeps
   * it for the thread's later turns too): model and effort, and the permission
   * and plan settings as T3 maps them. */
  nextTurn: z.object({
    model: z.string().min(1).max(200).optional(), effort: z.string().min(1).max(20).optional(),
    approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
    approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
    sandboxPolicy: z.object({ type: z.enum(["readOnly", "workspaceWrite", "dangerFullAccess"]) }).strict().optional(),
    collaborationMode: z.object({ mode: z.enum(["plan", "default"]) }).strict().optional(),
  }).strict().optional(),
}).strict();
export type CodexServerEntry = z.infer<typeof entrySchema>;
export type CodexNextTurn = NonNullable<CodexServerEntry["nextTurn"]>;

/** Where the Hook's approval cards come from and go: every server request of
 * a registered thread is offered here with the function that answers it, and
 * withdrawn once any client (the pane's TUI, or this one) answered it. */
export interface CodexApprovalSink {
  request(target: Target, request: PendingServerRequest, answer: (result: Json) => void): void;
  resolved(target: Target, requestId: AppServerRequestId): void;
}

export interface CodexServerDeps {
  spawn: typeof spawnAppServer;
  connect: typeof connectAppServer;
  /** True while `pid` is a running process. */
  alive(pid: number): boolean;
  kill(pid: number): void;
}

const defaultDeps: CodexServerDeps = {
  spawn: spawnAppServer,
  connect: connectAppServer,
  alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } },
  kill: pid => {
    // The detached server leads its own process group: end the group.
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  },
};

/** `PHREN_CODEX_APP_SERVER=off` keeps every Codex launch on the typed path. */
export function codexAppServerEnabled(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  // The server listens on a unix socket and the pane joins it with
  // `--remote unix://…`; Windows keeps the typed path.
  if (platform === "win32") return false;
  return !/^(?:0|off|false|no)$/i.test(env.PHREN_CODEX_APP_SERVER ?? "");
}

/** A question on a Hook-run pane reaches the phone as a card either way, but
 * only the blocking `request_user_input` holds the turn until someone answers:
 * an async question (`request_user_input_async`) lets the worker carry on
 * without the answer, and a plain-text question never becomes a card at all.
 * Codex 0.157 offers the blocking tool outside plan mode only behind
 * `features.default_mode_request_user_input`, and a short developer
 * instruction steers the model to it (as T3 Code's CodexDeveloperInstructions
 * does). `PHREN_CODEX_BLOCKING_QUESTIONS=off` leaves both out. */
export const BLOCKING_QUESTION_INSTRUCTIONS = "When you need the user to decide or supply something you cannot find out yourself, "
  + "ask with the `request_user_input` tool, which waits for the answer; the user answers it from their phone or this terminal. "
  + "Do not use `request_user_input_async` for that, and never write a multiple-choice question as a plain message. "
  + "Ask only when a reasonable assumption would be risky.";
export function serverConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  if (/^(?:0|off|false|no)$/i.test(env.PHREN_CODEX_BLOCKING_QUESTIONS ?? "")) return [];
  return ["features.default_mode_request_user_input=true", `developer_instructions=${JSON.stringify(BLOCKING_QUESTION_INSTRUCTIONS)}`];
}

/** The variable that tells a hook it runs inside the Hook's own app-server
 * for one pane, so the pane variables it carries are that pane's. */
export const CODEX_SERVER_ENV = "PHREN_CODEX_SERVER";
export const codexServerId = z.string().regex(/^[a-f0-9]{12}$/);

/** The server's environment: the Hook's own, minus the variables that name
 * the Hook's terminal, plus the pane's (so the hooks Codex runs inside the
 * server report this pane) and the caller's. */
export function serverEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^(?:HERDR_|TMUX$|TMUX_PANE$|PHREN_DISPATCH_ID$)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export function codexServersRoot(): string { return path.join(bridgeRoot(), REGISTRY); }

interface Live {
  entry: CodexServerEntry;
  client?: AppServerClient;
  /** Following the thread: its approvals and turn events reach this client.
   * A thread is resumable only once it has a turn, so a thread the pane's
   * TUI started is joined on the next tick after its first turn. */
  subscribed?: boolean;
  /** The thread's model as `thread/start` or `thread/resume` last reported it;
   * a collaboration mode has to name one. */
  model?: string;
  off?: () => void;
  connecting?: Promise<void>;
  /** When the pane was first seen without Codex. */
  agentGoneSince?: number;
  /** Recent file-change items by id: their approval request names only the item. */
  fileChanges?: Map<string, Json[]>;
}

/** Nothing was sent: the server could not be reached. */
export class CodexServerUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "CodexServerUnavailable"; }
}

export interface LaunchPlace { server: string; workspace: string; tab: string; pane: string }
export interface LaunchOptions {
  cwd: string;
  model?: string;
  effort?: string;
  /** Layered over the Hook's environment for the server and its hooks. */
  env?: Record<string, string>;
  dispatchId?: string;
}

export class CodexServers {
  private live = new Map<string, Live>();
  private sink?: CodexApprovalSink;
  private closed = false;
  constructor(private deps: CodexServerDeps = defaultDeps) {}

  setDeps(deps: Partial<CodexServerDeps>): () => void {
    const previous = this.deps;
    this.deps = { ...this.deps, ...deps };
    return () => { this.deps = previous; };
  }

  private readonly saving = new Map<string, Promise<void>>();

  setSink(sink: CodexApprovalSink | undefined): void { this.sink = sink; }

  entries(): CodexServerEntry[] { return [...this.live.values()].map(live => live.entry); }
  forPane(server: string, pane: string): CodexServerEntry | undefined {
    return [...this.live.values()].find(live => live.entry.server === server && live.entry.pane === pane)?.entry;
  }
  forThread(threadId: string): CodexServerEntry | undefined {
    return [...this.live.values()].find(live => live.entry.threadId !== undefined && live.entry.threadId === threadId)?.entry;
  }
  /** The server behind a Codex target, when the target is exactly its pane and thread. */
  forTarget(target: Target): CodexServerEntry | undefined {
    if (target.source !== "codex") return undefined;
    const entry = this.forPane(target.server, target.pane);
    return entry && entry.threadId !== undefined && entry.threadId === target.session && entry.workspace === target.workspace && entry.tab === target.tab ? entry : undefined;
  }

  /** A new server for a pane the Hook just created, and the arguments the
   * pane's `codex` joins it with. With `startThread` (a launch that carries a
   * brief) the Hook starts the thread and the pane resumes it:
   * `codex resume <threadId> --remote unix://<socket>`. Codex cannot resume a
   * thread with no turn yet, so without one the pane's TUI starts the thread
   * (`codex --remote unix://<socket>`, with the model and effort as its own
   * flags) and the Hook learns it from `thread/started` (`awaitThread`). The
   * caller `stop`s the server if the pane cannot start. */
  async launch(place: LaunchPlace, options: LaunchOptions & { startThread?: boolean }): Promise<{ entry: CodexServerEntry; args: string[] }> {
    const serverId = randomBytes(6).toString("hex");
    const directory = path.join(codexServersRoot(), serverId);
    const socket = path.join(directory, "app.sock");
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) throw new Error(`The Codex server socket path is too long: ${socket}`);
    await mkdir(codexServersRoot(), { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await this.deps.spawn({ socketPath: socket, cwd: options.cwd, detached: true, logFile: path.join(directory, "server.log"),
      config: serverConfig(), replaceEnv: true, env: serverEnvironment(process.env, { ...(options.env ?? {}), [CODEX_SERVER_ENV]: serverId }) }).catch(async error => {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    });
    const pid = handle.child.pid;
    let client: AppServerClient | undefined;
    try {
      if (!pid) throw new Error("codex app-server started without a process id");
      client = await this.deps.connect(socket, { clientName: CLIENT_NAME, clientTitle: "Phren Hook" });
      const entry = entrySchema.parse({ id: serverId, ...place, socket, pid, cwd: options.cwd, startedAt: new Date().toISOString(),
        ...(options.dispatchId ? { dispatchId: options.dispatchId } : {}) });
      const live: Live = { entry, client };
      // Listening before the thread exists, so its `thread/started` is not missed.
      this.listen(live, client);
      if (options.startThread) {
        const started = await client.threadStart({ cwd: options.cwd, ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { config: { model_reasoning_effort: options.effort } } : {}) });
        const threadId = object(started.thread).id;
        if (typeof threadId !== "string" || !threadId) throw new Error("codex app-server thread/start returned no thread id");
        entry.threadId = threadId;
        live.subscribed = true;
        if (typeof started.model === "string") live.model = started.model;
      }
      await this.save(entry);
      this.live.set(serverId, live);
      const args = entry.threadId ? ["resume", entry.threadId, "--remote", `unix://${socket}`]
        : ["--remote", `unix://${socket}`, ...(options.model ? ["--model", options.model] : []), ...(options.effort ? ["-c", `model_reasoning_effort=${options.effort}`] : [])];
      return { entry, args };
    } catch (error) {
      client?.close();
      await handle.stop().catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** The pane's thread once its TUI has started it; undefined after `timeoutMs`. */
  async awaitThread(entry: CodexServerEntry, timeoutMs = 10_000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (!entry.threadId && Date.now() < deadline && this.live.has(entry.id)) await new Promise(resolve => setTimeout(resolve, 100));
    return entry.threadId;
  }

  /** On Hook start: every registered server still running is reconnected
   * and its thread followed again (its pending approvals are replayed to
   * the new client); the rest are forgotten. */
  async adopt(): Promise<void> {
    this.closed = false;
    const names = await readdir(codexServersRoot()).catch(() => [] as string[]);
    for (const name of names.slice(0, 256)) {
      if (!codexServerId.safeParse(name).success || [...this.live.values()].some(live => live.entry.id === name)) continue;
      const entry = await this.read(name);
      if (!entry || !this.deps.alive(entry.pid)) { await this.forget(name); continue; }
      const live: Live = { entry };
      this.live.set(name, live);
      await this.connect(live).catch(error => logger.warn("codex-servers", `Could not reconnect to Codex server ${name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /** `turn/start` on the pane's thread; resolves with the turn id the server
   * acknowledged. Nothing is typed into the pane. */
  async prompt(entry: CodexServerEntry, text: string): Promise<{ turnId: string }> {
    if (!entry.threadId) throw new CodexServerUnavailable("The Codex pane has not started its thread yet.");
    const client = await this.client(entry);
    const live = this.live.get(entry.id)?.entry ?? entry, next = live.nextTurn;
    const modeModel = next?.model ?? this.live.get(entry.id)?.model;
    const collaborationMode = next?.collaborationMode && modeModel
      // The mode carries its own model and effort, which win over the turn's.
      ? { mode: next.collaborationMode.mode, settings: { model: modeModel, reasoning_effort: next.effort ?? null, developer_instructions: null } } : undefined;
    const started = await client.turnStart({ threadId: entry.threadId, input: [{ type: "text", text, text_elements: [] }],
      ...(next ? { ...(next.model ? { model: next.model } : {}), ...(next.effort ? { effort: next.effort } : {}),
        ...(next.approvalPolicy ? { approvalPolicy: next.approvalPolicy } : {}), ...(next.approvalsReviewer ? { approvalsReviewer: next.approvalsReviewer } : {}),
        ...(next.sandboxPolicy ? { sandboxPolicy: next.sandboxPolicy } : {}), ...(collaborationMode ? { collaborationMode } : {}) } : {}) });
    // Codex took the override with the turn; the turn's own record shows it.
    if (next && live.nextTurn === next) { delete live.nextTurn; void this.save(live).catch(() => undefined); }
    return started;
  }

  /** Holds a model and effort for the pane's next Hook-sent turn. Nothing is
   * typed into the TUI and a running turn is not disturbed. */
  setNextTurn(entry: CodexServerEntry, model: string, effort?: string): void {
    this.hold(entry, { model, effort });
    // A model chosen without an effort takes its own default, not the last one's.
    if (!effort) { const live = this.live.get(entry.id)?.entry; if (live?.nextTurn) delete live.nextTurn.effort; }
  }

  /** Holds permission and plan settings the same way, next to a pending model. */
  holdSettings(entry: CodexServerEntry, settings: Omit<CodexNextTurn, "model" | "effort">): void {
    const live = this.live.get(entry.id);
    if (settings.collaborationMode && !(live?.entry.nextTurn?.model ?? live?.model)) {
      throw new CodexServerUnavailable("Codex has not reported this thread's model yet. Send a message first, then change plan mode.");
    }
    this.hold(entry, settings);
  }

  /** Merges into what is pending: a later choice replaces its own fields only. */
  private hold(entry: CodexServerEntry, patch: Partial<Record<keyof CodexNextTurn, unknown>>): void {
    const live = this.live.get(entry.id)?.entry;
    if (!live) throw new CodexServerUnavailable("This Codex server is no longer registered.");
    live.nextTurn = { ...live.nextTurn, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as CodexNextTurn;
    void this.save(live).catch(() => undefined);
  }

  /** Input for the thread's running turn (`turn/steer`, as the TUI sends an
   * async question's answer), or a new turn when none is running or the one
   * it knew has ended. A refused steer sent nothing, so starting is safe. */
  async steer(entry: CodexServerEntry, text: string, extra: AppServerTurnInput[] = []): Promise<{ turnId: string }> {
    if (!entry.threadId) throw new CodexServerUnavailable("The Codex pane has not started its thread yet.");
    const client = await this.client(entry);
    const input = [{ type: "text", text, text_elements: [] }, ...extra];
    const running = this.live.get(entry.id)?.entry.activeTurn;
    if (running) {
      try { return await client.turnSteer({ threadId: entry.threadId, expectedTurnId: running, input }); }
      catch (error) { if (!(error instanceof AppServerRpcError)) throw error; }
    }
    return client.turnStart({ threadId: entry.threadId, input });
  }

  /** The thread's parked questions: `item/tool/requestUserInput` and MCP
   * elicitations, which wait for an answer from any client. */
  questions(entry: CodexServerEntry): PendingServerRequest[] {
    const client = this.live.get(entry.id)?.client;
    if (!client || !entry.threadId) return [];
    return [...client.pending.values()].filter(request => QUESTION_METHODS.has(request.method)
      && (request.threadId === undefined || request.threadId === entry.threadId));
  }

  /** Answers one parked question; false when no client still waits on it. */
  answerQuestion(entry: CodexServerEntry, requestId: AppServerRequestId, result: Json): boolean {
    const client = this.live.get(entry.id)?.client;
    if (!client?.pending.has(requestId)) return false;
    client.respond(requestId, result);
    return true;
  }

  /** One proactive refresh of the shared Codex sign-in (codex-auth-refresh.ts)
   * through Codex's own flow: on a running server's connection, or on a
   * short-lived server when none runs. */
  async refreshAuth(): Promise<void> {
    for (const live of this.live.values()) {
      if (!this.deps.alive(live.entry.pid)) continue;
      const client = await this.client(live.entry).catch(() => undefined);
      if (!client) continue;
      await client.request("account/read", { refreshToken: true });
      return;
    }
    const directory = await mkdtemp(path.join(tmpdir(), "phren-codex-auth-"));
    const socket = path.join(directory, "app.sock");
    try {
      const handle = await this.deps.spawn({ socketPath: socket, cwd: directory, replaceEnv: true, env: serverEnvironment(process.env, {}) });
      try {
        const client = await this.deps.connect(socket, { clientName: CLIENT_NAME, clientTitle: "Phren Hook" });
        try { await client.request("account/read", { refreshToken: true }); } finally { client.close(); }
      } finally { await handle.stop().catch(() => undefined); }
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  }

  /** Interrupt the running turn, declining the thread's parked server
   * requests first. False when no turn is known to be running. */
  async interrupt(entry: CodexServerEntry): Promise<boolean> {
    const live = this.live.get(entry.id);
    const turn = live?.entry.activeTurn, threadId = live?.entry.threadId;
    if (!live || !turn || !threadId) return false;
    const client = await this.client(entry);
    const parked = [...client.pending.values()].filter(request => request.threadId === undefined || request.threadId === threadId);
    await client.interruptTurn(threadId, turn);
    // Declined by this client, so no `serverRequest/resolved` comes back for them.
    for (const request of parked) this.sink?.resolved(this.target(live.entry), request.requestId);
    return true;
  }

  /** The last finished turn of a registered thread and the running one, for
   * the returns loop. */
  turnState(threadId: string): { activeTurn?: string; lastTurn?: CodexServerEntry["lastTurn"] } | undefined {
    const entry = this.forThread(threadId);
    return entry ? { ...(entry.activeTurn ? { activeTurn: entry.activeTurn } : {}), ...(entry.lastTurn ? { lastTurn: entry.lastTurn } : {}) } : undefined;
  }

  /** One Hook tick for `server`: forget servers whose process ended, stop
   * servers whose pane closed (or has shown no Codex for two minutes), and
   * reconnect a client that dropped. */
  async reap(server: string, snapshot: Json, now = Date.now()): Promise<void> {
    const panes = objects(snapshot.panes);
    for (const live of [...this.live.values()]) {
      const entry = live.entry;
      if (entry.server !== server) continue;
      if (!this.deps.alive(entry.pid)) { await this.drop(live); continue; }
      const pane = panes.find(candidate => candidate.pane_id === entry.pane);
      if (!pane) { await this.stop(entry); continue; }
      if (pane.agent === "codex") live.agentGoneSince = undefined;
      else {
        live.agentGoneSince ??= now;
        if (now - live.agentGoneSince >= AGENT_GONE_MS) { await this.stop(entry); continue; }
      }
      if (!live.client && !live.connecting) await this.connect(live).catch(() => undefined);
      else if (live.client && !live.subscribed && entry.threadId) await this.subscribe(live, live.client).catch(() => undefined);
    }
  }

  /** Servers whose terminal server is no longer running at all (a stopped
   * Herdr session takes its panes with it): forgotten once dead, stopped
   * after the same two minutes a pane without Codex gets. */
  async sweep(running: string[], now = Date.now()): Promise<void> {
    for (const live of [...this.live.values()]) {
      if (running.includes(live.entry.server)) continue;
      if (!this.deps.alive(live.entry.pid)) { await this.drop(live); continue; }
      live.agentGoneSince ??= now;
      if (now - live.agentGoneSince >= AGENT_GONE_MS) await this.stop(live.entry);
    }
  }

  /** The pane's TUI moved to `threadId` (`/new`, `/resume`), as its
   * SessionStart hook reports: follow it, so prompts, approvals and Escape
   * go where the TUI is. False when the pane has no registered server. */
  follow(server: string, pane: string, threadId: string): boolean {
    const live = [...this.live.values()].find(candidate => candidate.entry.server === server && candidate.entry.pane === pane);
    if (!live) return false;
    this.rebind(live, threadId);
    return true;
  }

  private rebind(live: Live, threadId: string): void {
    const entry = live.entry;
    if (entry.threadId === threadId) return;
    const previous = entry.threadId;
    // The old thread's cards cannot be answered from this pane any more.
    if (previous && live.client) {
      const target = this.target(entry);
      for (const request of live.client.pending.values()) if (request.threadId === undefined || request.threadId === previous) this.sink?.resolved(target, request.requestId);
    }
    entry.threadId = threadId;
    delete entry.activeTurn; delete entry.lastTurn;
    live.subscribed = false;
    void this.save(entry).catch(() => undefined);
    // A thread with no turn yet cannot be resumed; the tick tries again.
    if (live.client) void this.subscribe(live, live.client).catch(() => undefined);
  }

  /** Ends the server and forgets it. */
  async stop(entry: CodexServerEntry): Promise<void> {
    const live = this.live.get(entry.id);
    if (this.deps.alive(entry.pid)) this.deps.kill(entry.pid);
    if (live) await this.drop(live); else await this.forget(entry.id);
  }

  /** Close every client; the servers keep running for the next Hook. */
  close(): void {
    this.closed = true;
    for (const live of this.live.values()) { live.off?.(); live.client?.close(); live.client = undefined; }
    this.live.clear();
  }

  /** For tests: forget everything without touching processes. */
  reset(): void { this.close(); this.closed = false; }

  /** Resolves once every registry write started so far has finished. */
  async saved(): Promise<void> {
    await Promise.all([...this.saving.values()].map(write => write.catch(() => undefined)));
  }

  private target(entry: CodexServerEntry): Target {
    return { server: entry.server, workspace: entry.workspace, tab: entry.tab, pane: entry.pane, source: "codex", session: entry.threadId ?? "" };
  }

  /** Rejoin the thread: its history is skipped, its pending server requests
   * come again as requests. */
  private async subscribe(live: Live, client: AppServerClient): Promise<void> {
    const threadId = live.entry.threadId;
    if (!threadId) return;
    const resumed = await client.threadResume({ threadId });
    // The pane moved on while this was in flight: that thread's join decides.
    if (live.entry.threadId !== threadId) return;
    live.subscribed = true;
    if (typeof resumed.model === "string") live.model = resumed.model;
    // A turn that ended while no client listened: the recorded one is stale.
    if (object(object(resumed.thread).status).type === "idle") delete live.entry.activeTurn;
  }

  private async client(entry: CodexServerEntry): Promise<AppServerClient> {
    const live = this.live.get(entry.id);
    if (!live) throw new CodexServerUnavailable("This Codex server is no longer registered.");
    if (!live.client) await this.connect(live).catch(error => { throw new CodexServerUnavailable(`The Codex server is not reachable: ${error instanceof Error ? error.message : String(error)}`); });
    if (!live.client) throw new CodexServerUnavailable("The Codex server is not reachable.");
    return live.client;
  }

  private connect(live: Live): Promise<void> {
    if (live.connecting) return live.connecting;
    live.connecting = (async () => {
      const client = await this.deps.connect(live.entry.socket, { clientName: CLIENT_NAME, clientTitle: "Phren Hook" });
      live.subscribed = false;
      try {
        this.listen(live, client);
        // A thread without a turn cannot be resumed yet; the tick retries.
        await this.subscribe(live, client).catch(error => { if (!/no rollout/i.test(error instanceof Error ? error.message : "")) throw error; });
      } catch (error) { live.off?.(); live.off = undefined; client.close(); throw error; }
      if (this.closed || !this.live.has(live.entry.id)) { client.close(); return; }
      live.client = client;
    })().finally(() => { live.connecting = undefined; });
    return live.connecting;
  }

  private listen(live: Live, client: AppServerClient): void {
    live.off?.();
    const off = client.on(event => {
      const entry = live.entry;
      if (event.kind === "notification" && event.method === "thread/started") {
        // The pane's TUI started a thread: its first one, or a later /new.
        // Only the TUI and this Hook use the server, and the Hook starts a
        // thread only at launch, so a top-level thread in the pane's folder
        // is the one the pane now shows (helper threads, such as the one
        // naming the thread, have no environment; subagents have a parent).
        const thread = object(event.params.thread);
        const here = objects(thread.environments).some(environment => typeof environment.cwd === "string" && path.resolve(environment.cwd) === path.resolve(entry.cwd));
        if (typeof thread.id === "string" && thread.id && !thread.parentThreadId && here) this.rebind(live, thread.id);
        return;
      }
      if (!entry.threadId) return;
      if (event.kind === "request") {
        if (event.threadId !== undefined && event.threadId !== entry.threadId) return;
        const changes = event.method === "item/fileChange/requestApproval" ? live.fileChanges?.get(String(event.params.itemId)) : undefined;
        const request = changes ? { ...event, params: { ...event.params, changes } } : event;
        this.sink?.request(this.target(entry), request, result => client.respond(event.requestId, result));
        return;
      }
      if (event.kind === "resolved") {
        if (event.threadId === undefined || event.threadId === entry.threadId) this.sink?.resolved(this.target(entry), event.requestId);
        return;
      }
      if (event.params.threadId !== entry.threadId) return;
      const item = object(event.params.item);
      if (event.method === "item/started" && item.type === "fileChange" && typeof item.id === "string") {
        live.fileChanges ??= new Map();
        live.fileChanges.set(item.id, objects(item.changes).slice(0, 64));
        while (live.fileChanges.size > 32) live.fileChanges.delete(live.fileChanges.keys().next().value!);
      }
      const turn = object(event.params.turn);
      if (event.method === "turn/started" && typeof turn.id === "string") {
        entry.activeTurn = turn.id;
        void this.save(entry).catch(() => undefined);
      } else if (event.method === "turn/completed" && typeof turn.id === "string") {
        if (entry.activeTurn === turn.id) delete entry.activeTurn;
        entry.lastTurn = { id: turn.id, status: typeof turn.status === "string" ? turn.status : "completed", at: new Date().toISOString() };
        void this.save(entry).catch(() => undefined);
      }
    });
    // A dropped connection is reconnected on the next tick.
    const socketClosed = () => { if (live.client === client) live.client = undefined; };
    const offClose = client.onClose?.(socketClosed);
    live.off = () => { off(); offClose?.(); };
  }

  private async drop(live: Live): Promise<void> {
    live.off?.(); live.client?.close(); live.client = undefined;
    this.live.delete(live.entry.id);
    await this.forget(live.entry.id);
  }

  private async forget(serverId: string): Promise<void> {
    await rm(path.join(codexServersRoot(), codexServerId.parse(serverId)), { recursive: true, force: true }).catch(() => undefined);
  }

  private async read(serverId: string): Promise<CodexServerEntry | undefined> {
    try {
      const parsed = entrySchema.safeParse(JSON.parse(await readFile(path.join(codexServersRoot(), serverId, "server.json"), "utf8")));
      return parsed.success && parsed.data.id === serverId ? parsed.data : undefined;
    } catch { return undefined; }
  }

  /** One server's registry writes run in order, each with the entry as it is
   * then, so an earlier write that finishes late never lands over a newer one. */
  private save(entry: CodexServerEntry): Promise<void> {
    const file = path.join(codexServersRoot(), entry.id, "server.json");
    const next = (this.saving.get(entry.id) ?? Promise.resolve()).catch(() => undefined)
      .then(() => atomic(file, entrySchema.parse(entry)));
    this.saving.set(entry.id, next);
    void next.catch(() => undefined).finally(() => { if (this.saving.get(entry.id) === next) this.saving.delete(entry.id); });
    return next;
  }
}

/** The Hook's servers: launch, prompt and keys routes, identity and the
 * approval store all see the same registry. */
export const codexServers = new CodexServers();
