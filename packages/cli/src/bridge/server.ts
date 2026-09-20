import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { ActivityJournal } from "./activity.js";
import { AgentHooks } from "./agent-hooks.js";
import { homeDirectory, startChangeRetention } from "./changes.js";
import { WorkspaceContextUsage } from "./context.js";
import { candidateRepos, enrollProject } from "./enroll.js";
import { browseFiles } from "./files.js";
import { paneChatState, paneIdentity, panes, rpc, servers, snapshot, trustedDirectory, validateStartingTarget, validateTarget, workspaceSnapshot, startingPane } from "./herdr.js";
import { LaunchLimiter } from "./limits.js";
import { locateProject } from "./locate.js";
import { launchDirectory, repositoryBranch, repositoryDiff, webServers } from "./projects.js";
import { BridgeError, bridgeRoot, id, type Json, MAX_FRAME, object, objects, PROTOCOL, provider, type Provider, serverName, socketPath, startingTargetSchema, type Target, targetFromURL, targetSchema } from "./protocol.js";
import { CodexQuestions } from "./questions.js";
import { bootedSimulators, type SimulatorAction, simulatorAct, simulatorApps, simulatorScreenshot } from "./simulators.js";
import { TabActivityStore } from "./tab-activity.js";
import { childAgent, childAgentTree, conversationNamedPaths, historicalImage, publicChildAgents, refreshTranscript, TranscriptReader, transcriptPath } from "./transcripts.js";
import { listUploads, saveUpload, uploadImage } from "./uploads.js";
import { ModelCatalog } from "./models.js";
import { currentStep } from "./steps.js";
import { AccountUsageReader } from "./usage.js";

export const capabilities = { transcript: true, progress: true, images: true, prompt: true, stop: true,
  terminal: "ssh-pty", shell: "ssh-pty", herdr: true, diff: true, webServers: true, webPreview: "ssh-exec", activity: true,
  approvals: true, questions: false, accountUsage: true, providers: ["codex", "claude", "copilot", "opencode"],
  files: true, repositoryFiles: true, subagents: true, approvalPush: "direct-apns", simulators: process.platform === "darwin" };

/** A file from the phone: a plain name and base64 bytes, bounded. */
function uploadBody(data: Json): { name: string; bytes: Buffer } {
  const name = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,199}$/).refine(n => !n.includes("..")).parse(data.name);
  const encoded = z.string().max(11_184_812).regex(/^[A-Za-z0-9+/]*={0,2}$/).parse(data.data);
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_FRAME) throw new BridgeError(413, "The file is empty or too large.");
  return { name, bytes };
}

async function body(request: IncomingMessage): Promise<Json> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 11_500_000) throw new BridgeError(413, "Request is too large.");
    chunks.push(chunk);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
}

function selectedServer(url: URL): string {
  const mux = url.searchParams.get("mux");
  if (mux && !mux.startsWith("herdr:")) throw new BridgeError(400, "Select a Herdr server.");
  return serverName.parse(url.searchParams.get("server") || mux?.slice(6) || "default");
}

function send(socket: WebSocket, frame: unknown) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify(frame);
  if (Buffer.byteLength(data) > MAX_FRAME || socket.bufferedAmount > MAX_FRAME) { socket.close(1009, "Reconnect to resume the conversation"); return; }
  socket.send(data);
}

export async function serve(version: string): Promise<void> {
  process.umask(0o077);
  const root = bridgeRoot();
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  let computerID: string;
  const identityFile = path.join(root, "computer-id");
  try { computerID = (await readFile(identityFile, "utf8")).trim(); }
  catch { computerID = randomUUID(); await writeFile(identityFile, computerID, { flag: "wx", mode: 0o600 }); }
  const launches = new LaunchLimiter();
  const locatedDirectories = new Set<string>();
  const journal = new ActivityJournal();
  const agentHooks = new AgentHooks();
  const modelCatalog = new ModelCatalog();
  const contextUsage = new WorkspaceContextUsage();
  const accountUsage = new AccountUsageReader();
  const tabActivity = new TabActivityStore();
  const codexQuestions = new CodexQuestions();
  const info = { product: "phren-hook", protocol: PROTOCOL, version, computer: { id: computerID, name: hostname() }, capabilities };
  const old = await lstat(socketPath()).catch(() => null);
  if (old) {
    if (!old.isSocket() || (process.getuid && old.uid !== process.getuid())) throw new Error("Refusing to replace an unexpected hook socket.");
    // The service manager owns process lifetime. Only remove a stale socket.
    const { connect } = await import("node:net");
    const live = await new Promise<boolean>(resolve => { const s = connect(socketPath()); s.on("connect", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });
    if (live) throw new Error("Phren Hook is already running.");
    await unlink(socketPath());
  }

  const stopRetention = await startChangeRetention();
  await rm(path.join(root, "changes-scratch"), { recursive: true, force: true });
  const http = createServer(async (request, response) => {
    response.setHeader("X-Phren-Protocol", String(PROTOCOL));
    response.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(request.url || "/", "http://phren.local");
      if (url.origin !== "http://phren.local") throw new BridgeError(400, "Invalid request origin.");
      let result: unknown;
      if (request.method === "GET") {
        switch (url.pathname) {
          case "/v1/health": result = info; break;
          case "/v1/muxes": result = { muxes: await servers() }; break;
          case "/v1/activity": result = { events: await journal.recent() }; break;
          case "/v1/web-servers": result = { servers: await webServers() }; break;
          case "/v1/simulators": result = { simulators: await bootedSimulators() }; break;
          case "/v1/simulators/screenshot": {
            const bytes = await simulatorScreenshot(String(url.searchParams.get("udid") ?? ""));
            response.setHeader("Content-Type", "image/png"); response.end(bytes); return;
          }
          case "/v1/files": result = { files: await listUploads("files") }; break;
          case "/v1/models": result = { models: await modelCatalog.list(String(url.searchParams.get("source") ?? "")) }; break;
          case "/v1/projects/files": {
            const candidates = await locateProject(String(url.searchParams.get("project") ?? ""), await journal.recent());
            const directory = url.searchParams.get("directory");
            const candidate = directory ? candidates.find(item => item.directory === directory) : candidates[0];
            if (!candidate) throw new BridgeError(404, "This project folder is not available on this computer.");
            result = await browseFiles(candidate.directory, url.searchParams.get("path") ?? ""); break;
          }
          case "/v1/uploads/image": {
            // A picture the phone sent, as the transcript names it by path.
            const bytes = await uploadImage(String(url.searchParams.get("path") ?? ""));
            response.setHeader("Content-Type", "application/octet-stream"); response.end(bytes); return;
          }
          case "/v1/simulators/apps": result = { apps: await simulatorApps(String(url.searchParams.get("udid") ?? "")) }; break;
          case "/v1/usage": result = await accountUsage.read(); break;
          case "/v1/push/status": result = agentHooks.push.status; break;
          case "/v1/projects/locate": {
            const candidates = await locateProject(String(url.searchParams.get("project") ?? ""), await journal.recent());
            for (const candidate of candidates) {
              locatedDirectories.delete(candidate.directory); locatedDirectories.add(candidate.directory);
              if (locatedDirectories.size > 128) locatedDirectories.delete(locatedDirectories.values().next().value!);
            }
            result = { candidates }; break;
          }
          case "/v1/projects/repos": result = { repos: await candidateRepos(await journal.recent()) }; break;
          case "/v1/workspaces": {
            const server = selectedServer(url), s = await snapshot(server);
            const lastChanged = await tabActivity.observe(server, s);
            if (url.searchParams.get("watchApprovals") === "1") agentHooks.overview.renew(server);
            const context = await contextUsage.read(server, s);
            await journal.record(server, objects(s.panes));
            const chatStates = new Map(await Promise.all(objects(s.panes).filter(p => p.agent).map(async p =>
              [p, await paneChatState(server, p).catch((): Json => ({}))] as const)));
            const workspaces = workspaceSnapshot(s, context, agentHooks.pendingPanes(server, s), lastChanged);
            // The branch each tab's agent is on, for the session cards.
            for (const group of objects(workspaces.groups)) for (const tab of objects(group.children)) {
              const agents = objects(s.panes).filter(p => p.workspace_id === group.id && p.tab_id === tab.id && p.agent);
              if (agents.length === 1) {
                const chat = chatStates.get(agents[0]);
                if (chat?.starting === true) tab.starting = true;
              }
              if (typeof tab.cwd === "string" && tab.agent) tab.branch = await repositoryBranch(tab.cwd);
              // What a working agent is doing, for cards and the lock screen.
              if (agents.length === 1 && agents[0].agent_status === "working") {
                const session = chatStates.get(agents[0])?.sessionId;
                if (typeof session === "string" && provider.safeParse(agents[0].agent).success) {
                  const step = await currentStep(agents[0].agent as Provider, session).catch(() => undefined);
                  if (step) tab.currentStep = step;
                }
              }
            }
            result = { ...workspaces, phren: info }; break;
          }
          case "/v1/workspaces/panes": result = await panes(selectedServer(url), url.searchParams.get("groupId") || "", url.searchParams.get("childId") || ""); break;
          case "/v1/transcripts/blob": {
            const target = targetFromURL(url); await validateTarget(target);
            const inner = url.searchParams.get("inner");
            const bytes = await historicalImage(await transcriptPath(target.source, target.session), Number(url.searchParams.get("line")), Number(url.searchParams.get("block")), target.source, inner === null ? undefined : Number(inner));
            response.setHeader("Content-Type", "application/octet-stream"); response.end(bytes); return;
          }
          case "/v1/transcripts/history": {
            const target = targetFromURL(url);
            const before = z.coerce.number().int().positive().parse(url.searchParams.get("beforeLine"));
            const abort = new AbortController();
            response.once("close", () => { if (!response.writableEnded) abort.abort(); });
            await validateTarget(target);
            const child = url.searchParams.get("child");
            const { reader, source, session } = child === null ? await conversationReader(target) : await childConversationReader(target, child);
            if (reader) await refreshTranscript(reader.file, source, session);
            const page = reader ? await reader.read(before, abort.signal) : emptyPage;
            result = { ...page, type: "older", source, session }; break;
          }
          case "/v1/subagents": {
            const target = targetFromURL(url); await validateTarget(target);
            result = { agents: publicChildAgents(await childAgentTree(target.source, target.session)) }; break;
          }
          case "/v1/subagents/transcript": {
            const target = targetFromURL(url); await validateTarget(target);
            const { reader, source, session } = await childConversationReader(target, z.string().parse(url.searchParams.get("child")));
            const page = await reader.read();
            result = { ...page, type: "backlog", source, session }; break;
          }
          default: throw new BridgeError(404, "Unknown Phren Hook route.");
        }
      } else if (request.method === "POST") {
        const data = await body(request);
        if (url.pathname === "/v1/push/register") {
          await agentHooks.push.register(data); result = { ok: true };
        } else if (url.pathname === "/v1/push/answer") {
          await agentHooks.answerPush(z.string().uuid().parse(data.binding), data.decision); result = { ok: true };
        } else if (url.pathname === "/v1/files") {
          // Files the phone keeps on this computer, outside any session.
          const { name, bytes } = uploadBody(data);
          result = { ok: true, path: await saveUpload("files", name, bytes) };
        } else if (url.pathname === "/v1/projects/add") {
          // Enrolling a repository with phren from the phone: an existing
          // checkout, or a clone. Serialized like launches — one at a time.
          result = await launches.run(async () => enrollProject(z.object({ directory: z.string().max(4096).optional(), cloneUrl: z.string().max(512).optional() }).parse(data)));
        } else if (url.pathname === "/v1/simulators/action") {
          result = await simulatorAct(z.string().parse(data.udid), z.object({ action: z.string(), bundleId: z.string().optional(), url: z.string().optional(), x: z.number().optional(), y: z.number().optional(), text: z.string().optional(), submit: z.boolean().optional() }).parse(data) as unknown as SimulatorAction);
        } else {
        if (url.pathname === "/v1/workspaces/launch") {
          result = await launches.run(async () => launchSession(selectedServer(url), { ...data, cwd: await launchDirectory(data.cwd, await journal.recent(), locatedDirectories) }));
        } else if (url.pathname.startsWith("/v1/workspaces/")) {
          const operation = url.pathname.split("/").at(-1)!;
          result = operation === "create" ? await launches.run(async () => workspaceAction(selectedServer(url), operation,
            { ...data, cwd: await launchDirectory(data.cwd ?? homeDirectory(), await journal.recent(), locatedDirectories) }))
            : await workspaceAction(selectedServer(url), operation, data);
        } else {
          if (url.pathname === "/v1/keys" && object(data.target).starting === true) {
            // A folder-trust or login prompt comes before the agent has a
            // conversation; the phone answers it on the starting binding.
            const target = startingTargetSchema.parse(data.target);
            const pane = await startingPane(target);
            const keys = z.array(z.enum(ANSWER_KEYS)).min(1).max(4).parse(data.keys);
            if (!["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent is not waiting for an answer.");
            await rpc(target.server, "agent.send_keys", { target: target.pane, keys: keys.map(key => HERDR_KEYS[key] ?? key) });
            result = { ok: true };
          } else if (url.pathname === "/v1/secret" && object(data.target).starting === true) {
            // A password the terminal is reading before the agent has a
            // conversation is typed the same way as one after it.
            const target = startingTargetSchema.parse(data.target);
            const pane = await startingPane(target);
            const text = secretText.parse(data.text);
            if (!["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent is not waiting for an answer.");
            await typeSecret(target.server, target.pane, text);
            result = { ok: true };
          } else if (url.pathname === "/v1/prompt" && object(data.target).starting === true) {
            const target = startingTargetSchema.parse(data.target);
            const pane = await validateStartingTarget(target);
            const text = z.string().min(1).max(32768).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t)).parse(data.text);
            await rpc(target.server, "agent.prompt", { target: target.pane, text });
            // A first prompt may create its transcript immediately. Recheck the
            // terminal/process binding, not the absence of a session. Never retry.
            let confirmed = false;
            try {
              const current = objects((await snapshot(target.server)).panes).find(p => p.pane_id === target.pane && p.tab_id === target.tab && p.workspace_id === target.workspace && p.agent === target.source);
              confirmed = !!current && current.terminal_id === pane.terminal_id && (await paneChatState(target.server, current)).startingToken === target.startingToken;
            } catch { /* Already delivered; an uncertain reply must not resend. */ }
            result = { ok: true, ...(!confirmed ? { deliveryUncertain: true } : {}) };
          } else {
          const target = targetSchema.parse(data.target);
          // Uploads store bytes without answering or interrupting the agent.
          // They still require fresh identity, just like prompt mutations.
          const sendsInput = ["/v1/prompt", "/v1/keys", "/v1/secret"].includes(url.pathname);
          // A key press is how a prompt the agent draws in its terminal gets
          // answered, so keys are the one input allowed while the agent is
          // blocked or waiting; the status check below is theirs alone.
          const pane = await validateTarget(target, false, sendsInput || url.pathname === "/v1/upload");
          if (url.pathname === "/v1/prompt") {
            // A waiting agent takes typed text only when nothing structured
            // is pending there: an approval the Hook holds or saw, or a
            // status Herdr cannot read. Otherwise the answer keys are the way.
            const status = String(pane.agent_status);
            if (status === "unknown" || (["blocked", "waiting"].includes(status) && (agentHooks.approval(target) || agentHooks.terminalPrompt(target)))) {
              throw new BridgeError(409, "This agent needs input in the terminal first.");
            }
          }
          if (url.pathname === "/v1/prompt") {
            const text = z.string().min(1).max(32768).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t)).parse(data.text);
            // Herdr types into the pane; the agent that receives the text
            // confirms or refuses it through its UserPromptSubmit hook, by
            // conversation. That is the binding Herdr's own API lacks.
            const expected = agentHooks.expectDelivery(target, text);
            await rpc(target.server, "agent.prompt", { target: target.pane, text });
            const outcome = await expected;
            if (outcome === "blocked") throw new BridgeError(409, "The conversation in this pane changed; the message was not delivered. Reopen the chat and send it again.");
            // A bare slash command opens the agent's own menu; the phone may
            // walk it with keys for the next half minute.
            if (/^\/[a-z][a-z0-9_-]*$/i.test(text.trim())) agentHooks.menuOpened(target);
            if (outcome === "delivered") { result = { ok: true, delivered: true }; }
            else {
              // The agent has not submitted it yet (a busy agent queues typed
              // input). Recheck fresh identity and never retry; a late
              // submission to another conversation is still refused above.
              let confirmed = false;
              try {
                const current = objects((await snapshot(target.server)).panes).find(p => p.pane_id === target.pane && p.tab_id === target.tab && p.workspace_id === target.workspace && p.agent === target.source);
                confirmed = !!current && current.terminal_id === pane.terminal_id && await paneIdentity(target.server, current, true) === target.session;
              } catch { /* No reliable post-delivery identity. */ }
              result = { ok: true, ...(!confirmed ? { deliveryUncertain: true } : {}) };
            }
          } else if (url.pathname === "/v1/keys") {
            const keys = z.array(z.enum(ANSWER_KEYS)).min(1).max(4).parse(data.keys);
            const status = String(pane.agent_status), menu = agentHooks.menuOpen(target);
            // Escape interrupts a working agent. Everything else answers a
            // prompt the agent is holding: a menu, a y/n, a trust question.
            if (!menu && (keys.every(key => key === "Escape") ? !["working", "blocked", "waiting", "unknown"].includes(status)
              : !["blocked", "waiting", "unknown"].includes(status))) throw new BridgeError(409, keys.every(key => key === "Escape") ? "This agent is no longer working." : "This agent is not waiting for an answer.");
            await rpc(target.server, "agent.send_keys", { target: target.pane, keys: keys.map(key => HERDR_KEYS[key] ?? key) });
            if (keys.some(key => key !== "Up" && key !== "Down" && key !== "Tab")) { agentHooks.clearTerminalPrompt(target); agentHooks.menuClosed(target); }
            result = { ok: true };
          } else if (url.pathname === "/v1/secret") {
            // A password the terminal is reading (sudo, a login) cannot be
            // pasted: bracketed paste corrupts a tty read, so it is typed a
            // character at a time. The Hook never logs, echoes or stores it.
            const text = secretText.parse(data.text);
            if (!["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent is not waiting for an answer.");
            await typeSecret(target.server, target.pane, text);
            agentHooks.clearTerminalPrompt(target);
            result = { ok: true };
          } else if (url.pathname === "/v1/upload") {
            const { name, bytes } = uploadBody(data);
            result = { ok: true, path: await saveUpload(target.session, name, bytes) };
          } else if (url.pathname === "/v1/diff") {
            const child = z.string().regex(/^[a-f0-9]{32}$/).optional().parse(data.child);
            if (child !== undefined) {
              // A spawned agent: its own worktree for a fan-out, otherwise the
              // parent's checkout. The whole repository, no phone-named paths.
              const relation = childAgent(await childAgentTree(target.source, target.session), child);
              if (!relation) throw new BridgeError(404, "That agent is not part of this conversation.");
              result = await repositoryDiff(relation.cwd ?? await trustedDirectory(pane), [], []);
            } else {
              const cwd = await trustedDirectory(pane), paths = z.array(z.string().max(4096)).max(24).optional().parse(data.paths) ?? [];
              const abort = new AbortController();
              response.once("close", () => { if (!response.writableEnded) abort.abort(); });
              const allowed = paths.length ? await agentHooks.changes.recordedPaths(`${target.source}:${target.session}`) : [];
              if (paths.length) {
                try { allowed.push(...await conversationNamedPaths(await transcriptPath(target.source, target.session), target.source, cwd, abort.signal)); }
                catch { abort.signal.throwIfAborted(); /* Missing transcripts grant no extra paths; recorded scope still works. */ }
              }
              result = await repositoryDiff(cwd, paths, allowed);
            }
          }
          else if (url.pathname === "/v1/approvals/answer") {
            const actionId = target.source === "opencode"
              ? z.string().regex(/^[A-Za-z0-9_]{1,200}$/).parse(data.actionId)
              : z.string().uuid().parse(data.actionId);
            await agentHooks.answer(target, actionId, data.decision, data.updatedInput); result = { ok: true };
          } else if (url.pathname === "/v1/questions/answer") {
            await codexQuestions.answer(target, data); result = { ok: true };
          }
          else throw new BridgeError(404, "Unknown Phren Hook route.");
          }
        }
      }
      } else throw new BridgeError(405, "Unsupported request method.");
      const payload = JSON.stringify(result);
      if (Buffer.byteLength(payload) > MAX_FRAME) throw new BridgeError(413, "The response is too large.");
      response.setHeader("Content-Type", "application/json"); response.end(payload);
    } catch (error) {
      response.statusCode = error instanceof BridgeError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: error instanceof BridgeError ? error.message : "Phren Hook could not complete this request. Run phren bridge doctor on the computer." }));
    }
  });
  http.requestTimeout = 20_000; http.headersTimeout = 10_000; http.maxHeadersCount = 32;
  const ws = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  /** A conversation the agent has identified but not written yet (Claude
   * Code creates its file on the first turn) is an empty transcript, not a
   * missing one: `reader` stays undefined until the file appears. */
  async function conversationReader(target: Target): Promise<{ reader?: TranscriptReader; source: Provider; session: string }> {
    try {
      const reader = new TranscriptReader(await transcriptPath(target.source, target.session), target.source, undefined, agentHooks.changes.view(`${target.source}:${target.session}`));
      return { reader, source: target.source, session: target.session };
    } catch (error) {
      if (error instanceof BridgeError && error.status === 404) return { source: target.source, session: target.session };
      throw error;
    }
  }
  const emptyPage = { entries: [], totalLines: 0, startLine: 0, hasMore: false, reset: true };
  /** The transcript of an agent the conversation spawned. The child is a
   * parent-scoped id from `/v1/subagents`; the file is only ever reached
   * through the relation, never by a path or session the phone names. */
  async function childConversationReader(target: Target, child: string) {
    const relation = childAgent(await childAgentTree(target.source, target.session), child);
    if (!relation) throw new BridgeError(404, "This child agent does not belong to the selected conversation.");
    const reader = new TranscriptReader(relation.transcript, relation.provider, undefined, undefined, relation.provider === "claude");
    return { reader, source: relation.provider, session: relation.id };
  }
  http.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url || "/", "http://phren.local");
      if (!["/v1/transcripts", "/v1/status"].includes(url.pathname) || url.origin !== "http://phren.local") { socket.destroy(); return; }
      ws.handleUpgrade(request, socket, head, client => {
        while (ws.clients.size > 16) {
          const oldest = ws.clients.values().next().value!;
          oldest.close(1008, "Too many connections; reconnect"); oldest.terminate();
          ws.clients.delete(oldest);
        }
        void stream(client, url).catch(() => client.close(1011, "Conversation unavailable; refresh"));
      });
    } catch { socket.destroy(); }
  });
  async function stream(client: WebSocket, url: URL) {
    const abort = new AbortController();
    let reader: TranscriptReader | undefined, timer: ReturnType<typeof setInterval> | undefined;
    let unwatch: (() => void) | undefined;
    let busy = false, ready = false, first = true;
    let awaitingTranscript = false, lastTranscriptLookup = 0;
    let initialPane: Json;
    const pending: number[] = [];
    const stop = () => { abort.abort(); clearInterval(timer); unwatch?.(); pending.length = 0; };
    client.once("close", stop); client.once("error", stop);
    // Even rejected upgrades may already contain invalid WebSocket frames.
    // Handle their errors before parsing any untrusted destination fields.
    const target = targetFromURL(url);
    // A child agent's transcript streams through the same socket, bound to
    // the parent conversation: the parent target is what gets revalidated
    // each tick, and the frames name the child by its parent-scoped id.
    const child = url.pathname === "/v1/transcripts" ? url.searchParams.get("child") : null;
    let conversation = { source: target.source, session: target.session };
    // The transcript file of a fresh conversation appears with its first
    // turn; until then the socket carries an empty backlog and keeps looking.
    const findTranscript = async () => {
      if (Date.now() - lastTranscriptLookup < 2_000) return;
      lastTranscriptLookup = Date.now();
      const opened = await conversationReader(target);
      if (opened.reader) { reader = opened.reader; conversation = { source: opened.source, session: opened.session }; awaitingTranscript = false; }
    };
    const tick = async () => {
      if (busy || !ready || abort.signal.aborted) return; busy = true;
      try {
        if (first || pending.length === 0) {
          const pane = first ? initialPane : await validateTarget(target);
          if (awaitingTranscript) await findTranscript();
          if (awaitingTranscript) {
            if (first) send(client, { ...emptyPage, type: "backlog", ...conversation });
          } else if (reader) {
            await refreshTranscript(reader.file, conversation.source, conversation.session);
            const page = await reader.read(undefined, abort.signal);
            if (first || page.entries.length || page.reset) send(client, { ...page, type: first || page.reset ? "backlog" : "append", ...conversation });
          } else {
            const pendingApproval = agentHooks.approval(target);
            const pendingQuestions = target.source === "codex" ? await codexQuestions.pending(target).catch(() => undefined) : undefined;
            const cwd = await trustedDirectory(pane).catch(() => undefined);
            const branch = cwd ? await repositoryBranch(cwd) : undefined;
            const terminalPrompt = !pendingApproval && ["blocked", "waiting"].includes(String(pane.agent_status)) ? agentHooks.terminalPrompt(target) : undefined;
            send(client, { agentStatus: { source: target.source, session: target.session,
              status: pendingApproval ? "waiting" : pane.agent_status, pendingApproval, pendingQuestions, terminalPrompt,
              capabilities: { ...capabilities, asyncQuestions: target.source === "codex" && codexQuestions.available }, branch } });
          }
          first = false;
        }
        while (pending.length && reader && !abort.signal.aborted) {
          const before = pending.shift()!;
          await validateTarget(target);
          const page = await reader.read(before, abort.signal);
          send(client, { ...page, type: "older", ...conversation });
        }
      } catch { stop(); client.close(1011, "The conversation changed; refresh"); }
      finally { busy = false; if (pending.length) void tick(); }
    };
    client.on("message", bytes => {
      try {
        const message = object(JSON.parse(bytes.toString()));
        if (message.type !== "older" || url.pathname !== "/v1/transcripts" || abort.signal.aborted) return;
        const before = z.number().int().positive().parse(message.beforeLine);
        if (pending.length >= 8) throw new Error("History queue is full");
        if (!pending.includes(before)) pending.push(before);
        void tick();
      } catch { stop(); client.close(1008, "Invalid history request"); }
    });
    try {
      initialPane = await validateTarget(target);
      if (abort.signal.aborted) return;
      unwatch = agentHooks.watch(target);
      if (url.pathname === "/v1/transcripts") {
        const opened = child === null ? await conversationReader(target) : await childConversationReader(target, child);
        reader = opened.reader; conversation = { source: opened.source, session: opened.session };
        awaitingTranscript = child === null && !reader; lastTranscriptLookup = Date.now();
      }
      if (abort.signal.aborted) { stop(); return; }
      ready = true;
      timer = setInterval(() => { void tick(); }, reader || awaitingTranscript ? 500 : 1500);
      await tick();
    } catch (error) { stop(); throw error; }
  }
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(socketPath(), () => resolve()); });
  await chmod(socketPath(), 0o600);
  await agentHooks.start();
  let recording = false;
  const activityTimer = setInterval(() => {
    if (recording) return;
    recording = true;
    void (async () => {
      const live = await servers();
      await tabActivity.pruneServers(live.map(server => String(server.session)));
      for (const server of live) {
        try {
          const name = String(server.session), current = await snapshot(name);
          await tabActivity.observe(name, current);
          await journal.record(name, objects(current.panes));
        }
        catch { /* A disconnected computer keeps its previous local activity. */ }
      }
    })().finally(() => { recording = false; }).catch(() => {});
  }, 5000);
  await new Promise<void>(resolve => {
    const stop = () => { stopRetention(); clearInterval(activityTimer); agentHooks.close(); ws.clients.forEach(c => c.terminate()); ws.close(); http.close(() => resolve()); http.closeAllConnections(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  });
  await unlink(socketPath()).catch(() => {});
}

/** The phone can press these and nothing else; never a typed string. */
const ANSWER_KEYS = ["Escape", "Enter", "Up", "Down", "Tab", "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const HERDR_KEYS: Partial<Record<(typeof ANSWER_KEYS)[number], string>> = { Escape: "esc", Enter: "enter", Up: "up", Down: "down", Tab: "tab" };

/** A secret typed into a terminal prompt: printable, bounded, never logged. */
const secretText = z.string().min(1).max(256).refine(t => !/[\x00-\x1f\x7f]/.test(t));

/** One key per character; Herdr's send_keys takes single characters and named
 * keys only, and a tty password read is corrupted by a bracketed paste. */
function secretKeys(text: string): string[] {
  return [...text].map(character => character === " " ? "space" : character);
}

/** Type a secret, then submit it. A chunk that may already have reached the
 * terminal is never resent; the phone is told to check it by hand. */
async function typeSecret(server: string, pane: string, text: string): Promise<void> {
  const keys = secretKeys(text);
  let sent = false;
  for (let index = 0; index < keys.length; index += 32) {
    try {
      await rpc(server, "agent.send_keys", { target: pane, keys: keys.slice(index, index + 32) });
      sent = true;
    } catch (error) {
      if (sent) throw new BridgeError(502, "The password may have been typed only partly; check the terminal.");
      throw error;
    }
  }
  try {
    await rpc(server, "agent.send_keys", { target: pane, keys: ["enter"] });
  } catch (error) {
    if (sent) throw new BridgeError(502, "The password may have been typed only partly; check the terminal.");
    throw error;
  }
}

const launchKinds = ["codex", "claude", "copilot", "opencode"] as const;
const plainText = (max: number) => z.string().min(1).max(max).refine(t => !/[\x00-\x1f\x7f]/.test(t));

/**
 * "Open on a computer": a new Herdr workspace (or a tab in an existing one)
 * in the project's directory, with the chosen agent started in its pane.
 * Herdr's create calls do not return identifiers, so the new tab is found
 * by diffing snapshots; `agent.start` returns once Herdr has detected the
 * agent and it is ready for input, which can take most of `timeoutMs`.
 */
async function launchSession(server: string, data: Json): Promise<Json> {
  const cwd = z.string().min(1).max(4096).refine(t => path.isAbsolute(t) && !/[\x00-\x1f\x7f]/.test(t)).parse(data.cwd);
  const label = plainText(200).parse(data.label);
  const kind = z.enum(launchKinds).parse(data.kind);
  const name = data.name === undefined ? label : plainText(200).parse(data.name);
  const model = typeof data.model === "string" && data.model.trim() ? plainText(200).parse(data.model.trim()) : undefined;
  const modelFlag: Partial<Record<(typeof launchKinds)[number], string>> = { codex: "--model", claude: "--model", opencode: "--model" };
  const args = model && modelFlag[kind] ? [modelFlag[kind], model] : undefined;
  const workspace = data.workspaceId === undefined ? undefined : id.parse(data.workspaceId);
  const timeout = Math.min(120_000, Math.max(3_000, data.timeoutMs === undefined ? 45_000 : z.number().int().parse(data.timeoutMs)));
  const before = await snapshot(server);
  if (workspace && !objects(before.workspaces).some(w => w.workspace_id === workspace)) throw new BridgeError(409, "The workspace changed.");
  const knownWorkspaces = new Set(objects(before.workspaces).map(w => w.workspace_id));
  const knownTabs = new Set(objects(before.tabs).map(t => t.tab_id));
  await rpc(server, workspace ? "tab.create" : "workspace.create", { workspace_id: workspace, label, cwd, focus: false, env: {} });
  let created: { workspaceId: string; tabId: string; paneId: string } | undefined;
  for (let attempt = 0; attempt < 25 && !created; attempt++) {
    const s = await snapshot(server);
    const fresh = objects(s.tabs).filter(t => !knownTabs.has(t.tab_id)
      && (workspace ? t.workspace_id === workspace : !knownWorkspaces.has(t.workspace_id)));
    const tab = fresh.find(t => t.label === label)
      ?? fresh.find(t => objects(s.workspaces).some(w => w.workspace_id === t.workspace_id && w.label === label))
      ?? fresh[0];
    const pane = tab && objects(s.panes).find(p => p.tab_id === tab.tab_id && p.workspace_id === tab.workspace_id && !p.agent);
    if (tab && pane && id.safeParse(tab.workspace_id).success && id.safeParse(tab.tab_id).success && id.safeParse(pane.pane_id).success) {
      created = { workspaceId: String(tab.workspace_id), tabId: String(tab.tab_id), paneId: String(pane.pane_id) };
    } else await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!created) throw new BridgeError(409, `Herdr created "${label}" but its pane did not appear. Check Herdr on the computer.`);
  try {
    await rpc(server, "agent.start", { name, kind, pane_id: created.paneId, timeout_ms: timeout, ...(args ? { args } : {}) }, undefined, timeout + 5_000);
  } catch (error) {
    const reason = error instanceof BridgeError && error.status === 504 ? "it did not become ready in time" : "Herdr reported an error";
    throw new BridgeError(409, `Herdr couldn't start ${kind} in the new "${label}" pane (${reason}). The workspace was created and is still open on the computer — open it from Herdr workspaces.`);
  }
  const after = await snapshot(server);
  const pane = objects(after.panes).find(p => p.pane_id === created!.paneId && p.tab_id === created!.tabId && p.workspace_id === created!.workspaceId);
  const agentStatus = typeof pane?.agent_status === "string" ? pane.agent_status : undefined;
  const sessionId = pane && pane.agent === kind ? await paneIdentity(server, pane) : undefined;
  return { ok: true, ...created, agent: kind, agentStatus, sessionId };
}

async function workspaceAction(server: string, operation: string, data: Json): Promise<Json> {
  if (!["focus", "rename", "create", "close"].includes(operation)) throw new BridgeError(400, "Unsupported Herdr action.");
  const s = await snapshot(server);
  const workspace = typeof data.workspaceId === "string" ? data.workspaceId : undefined;
  const tab = typeof data.tabId === "string" ? data.tabId : undefined;
  const pane = typeof data.paneId === "string" ? data.paneId : undefined;
  if (workspace && !objects(s.workspaces).some(w => w.workspace_id === workspace)) throw new BridgeError(409, "The workspace changed.");
  if (tab && !objects(s.tabs).some(t => t.tab_id === tab && (!workspace || t.workspace_id === workspace))) throw new BridgeError(409, "The tab changed.");
  if (pane && !objects(s.panes).some(p => p.pane_id === pane && (!tab || p.tab_id === tab) && (!workspace || p.workspace_id === workspace))) throw new BridgeError(409, "The pane changed.");
  const label = data.label === undefined ? undefined : z.string().min(1).max(200).refine(t => !/[\x00-\x1f\x7f]/.test(t)).parse(data.label);
  const cwd = data.cwd === undefined ? undefined : z.string().max(4096).refine(t => path.isAbsolute(t) && !/[\x00-\x1f\x7f]/.test(t)).parse(data.cwd);
  if (operation === "create") await rpc(server, workspace ? "tab.create" : "workspace.create", { workspace_id: workspace, label, cwd, focus: false, env: {} });
  else if (!workspace && !tab && !pane) throw new BridgeError(400, "Choose a Herdr destination.");
  else if (pane && operation === "focus") await rpc(server, "pane.focus", { pane_id: pane });
  else if (pane) throw new BridgeError(400, "This pane action is not available.");
  else await rpc(server, `${tab ? "tab" : "workspace"}.${operation}`, { ...(tab ? { tab_id: tab } : { workspace_id: workspace }), ...(label ? { label } : {}) });
  return { ok: true };
}
