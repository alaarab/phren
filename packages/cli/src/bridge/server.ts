import { createServer, type IncomingMessage } from "node:http";
import { chmod, mkdir, lstat, unlink, writeFile, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { ActivityJournal } from "./activity.js";
import { panes, rpc, servers, snapshot, trustedDirectory, validateTarget, workspaceSnapshot } from "./herdr.js";
import { BridgeError, bridgeRoot, MAX_FRAME, object, objects, PROTOCOL, serverName, socketPath, targetFromURL, targetSchema, type Json } from "./protocol.js";
import { repositoryDiff, webServers } from "./projects.js";
import { historicalImage, TranscriptReader, transcriptPath } from "./transcripts.js";
import { AgentHooks } from "./agent-hooks.js";
import { saveUpload } from "./uploads.js";

export const capabilities = { transcript: true, progress: true, images: true, prompt: true, stop: true,
  terminal: "ssh-pty", herdr: true, diff: true, webServers: true, activity: true,
  approvals: true, questions: false, providers: ["codex", "claude", "copilot"] };

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
  const root = bridgeRoot();
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  let computerID: string;
  const identityFile = path.join(root, "computer-id");
  try { computerID = (await readFile(identityFile, "utf8")).trim(); }
  catch { computerID = randomUUID(); await writeFile(identityFile, computerID, { flag: "wx", mode: 0o600 }); }
  const journal = new ActivityJournal();
  const agentHooks = new AgentHooks();
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
          case "/v1/workspaces": {
            const server = selectedServer(url), s = await snapshot(server);
            await journal.record(server, objects(s.panes)); result = { ...workspaceSnapshot(s), phren: info }; break;
          }
          case "/v1/workspaces/panes": result = await panes(selectedServer(url), url.searchParams.get("groupId") || "", url.searchParams.get("childId") || ""); break;
          case "/v1/transcripts/blob": {
            const target = targetFromURL(url); await validateTarget(target);
            const bytes = await historicalImage(await transcriptPath(target.source, target.session), Number(url.searchParams.get("line")), Number(url.searchParams.get("block")), target.source);
            response.setHeader("Content-Type", "application/octet-stream"); response.end(bytes); return;
          }
          case "/v1/transcripts/history": {
            const target = targetFromURL(url);
            const before = z.coerce.number().int().positive().parse(url.searchParams.get("beforeLine"));
            const abort = new AbortController();
            response.once("close", () => { if (!response.writableEnded) abort.abort(); });
            await validateTarget(target);
            const reader = new TranscriptReader(await transcriptPath(target.source, target.session), target.source);
            const page = await reader.read(before, abort.signal);
            result = { ...page, type: "older", source: target.source, session: target.session }; break;
          }
          default: throw new BridgeError(404, "Unknown Phren Hook route.");
        }
      } else if (request.method === "POST") {
        const data = await body(request);
        if (url.pathname.startsWith("/v1/workspaces/")) {
          result = await workspaceAction(selectedServer(url), url.pathname.split("/").at(-1)!, data);
        } else {
          const target = targetSchema.parse(data.target);
          const pane = await validateTarget(target, ["/v1/prompt", "/v1/upload", "/v1/keys"].includes(url.pathname));
          if (url.pathname === "/v1/prompt") {
            const text = z.string().min(1).max(32768).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t)).parse(data.text);
            await rpc(target.server, "agent.prompt", { target: target.pane, text }); result = { ok: true };
          } else if (url.pathname === "/v1/keys") {
            if (JSON.stringify(data.keys) !== '["Escape"]' || pane.agent_status !== "working") throw new BridgeError(409, "This agent is no longer working.");
            await rpc(target.server, "agent.send_keys", { target: target.pane, keys: ["esc"] }); result = { ok: true };
          } else if (url.pathname === "/v1/upload") {
            const name = z.string().regex(/^[A-Za-z0-9_.-]{1,200}\.(png|jpg|jpeg|gif|webp)$/i).parse(data.name);
            const encoded = z.string().max(11_184_812).regex(/^[A-Za-z0-9+/]*={0,2}$/).parse(data.data);
            const bytes = Buffer.from(encoded, "base64");
            if (!bytes.length || bytes.length > MAX_FRAME) throw new BridgeError(413, "The image is too large.");
            result = { ok: true, path: await saveUpload(target.session, name, bytes) };
          } else if (url.pathname === "/v1/diff") result = await repositoryDiff(await trustedDirectory(pane));
          else if (url.pathname === "/v1/approvals/answer") {
            await agentHooks.answer(target, z.string().uuid().parse(data.actionId), data.decision); result = { ok: true };
          } else if (url.pathname === "/v1/questions/answer") throw new BridgeError(409, "Answer this agent's request in the Phren terminal.");
          else throw new BridgeError(404, "Unknown Phren Hook route.");
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
  http.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url || "/", "http://phren.local");
      if (!["/v1/transcripts", "/v1/status"].includes(url.pathname) || url.origin !== "http://phren.local") { socket.destroy(); return; }
      ws.handleUpgrade(request, socket, head, client => { void stream(client, url).catch(() => client.close(1011, "Conversation unavailable; refresh")); });
    } catch { socket.destroy(); }
  });
  async function stream(client: WebSocket, url: URL) {
    const target = targetFromURL(url);
    const abort = new AbortController();
    let reader: TranscriptReader | undefined, timer: ReturnType<typeof setInterval> | undefined;
    let unwatch: (() => void) | undefined;
    let busy = false, ready = false, first = true;
    let initialPane: Json;
    const pending: number[] = [];
    const stop = () => { abort.abort(); clearInterval(timer); unwatch?.(); pending.length = 0; };
    client.once("close", stop); client.once("error", stop);
    const tick = async () => {
      if (busy || !ready || abort.signal.aborted) return; busy = true;
      try {
        if (first || pending.length === 0) {
          const pane = first ? initialPane : await validateTarget(target);
          if (reader) {
            const page = await reader.read(undefined, abort.signal);
            if (first || page.entries.length || page.reset) send(client, { ...page, type: first || page.reset ? "backlog" : "append", source: target.source,
              session: target.session });
          } else {
            const pendingApproval = agentHooks.approval(target);
            send(client, { agentStatus: { source: target.source, session: target.session,
              status: pendingApproval ? "waiting" : pane.agent_status, pendingApproval, capabilities } });
          }
          first = false;
        }
        while (pending.length && reader && !abort.signal.aborted) {
          const before = pending.shift()!;
          await validateTarget(target);
          const page = await reader.read(before, abort.signal);
          send(client, { ...page, type: "older", source: target.source, session: target.session });
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
      reader = url.pathname === "/v1/transcripts" ? new TranscriptReader(await transcriptPath(target.source, target.session), target.source) : undefined;
      if (abort.signal.aborted) { stop(); return; }
      ready = true;
      timer = setInterval(() => { void tick(); }, reader ? 500 : 1500);
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
      for (const server of await servers()) {
        try { await journal.record(String(server.session), objects((await snapshot(String(server.session))).panes)); }
        catch { /* A disconnected computer keeps its previous local activity. */ }
      }
    })().finally(() => { recording = false; }).catch(() => {});
  }, 5000);
  await new Promise<void>(resolve => {
    const stop = () => { clearInterval(activityTimer); agentHooks.close(); ws.clients.forEach(c => c.terminate()); ws.close(); http.close(() => resolve()); http.closeAllConnections(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  });
  await unlink(socketPath()).catch(() => {});
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
