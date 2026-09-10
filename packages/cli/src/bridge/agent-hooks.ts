import { request, createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile, readFile, rename, chmod, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError, bridgeRoot, object, objects, provider, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { herdrRoot, rpc, snapshot, validateTarget } from "./herdr.js";

const localSocket = () => path.join(bridgeRoot(), "agent.sock");
const bindingPath = (server: string, pane: string) => path.join(bridgeRoot(), "bindings", server, encodeURIComponent(pane) + ".json");
export async function recordedSession(server: string, pane: Json, pids: number[]): Promise<string | undefined> {
  try {
    const value = object(JSON.parse(await readFile(bindingPath(server, String(pane.pane_id)), "utf8")));
    if (value.terminal !== pane.terminal_id || value.source !== pane.agent || !Array.isArray(value.pids) || !value.pids.some(p => pids.includes(Number(p)))) return undefined;
    return z.string().uuid().parse(value.session);
  } catch { return undefined; }
}

interface Pending { target: Target; response: ServerResponse; tool: string; message: string; timer: NodeJS.Timeout }
/** This socket is deliberately separate from the phone's HTTP pipe. Only local
 * agent callbacks can register identities or create an approval request. */
export class AgentHooks {
  private pending = new Map<string, Pending>();
  private watching = new Map<string, number>();
  private server?: Server;
  watch(target: Target): () => void {
    const key = JSON.stringify(target);
    this.watching.set(key, (this.watching.get(key) || 0) + 1);
    return () => { const n = (this.watching.get(key) || 1) - 1; if (n) this.watching.set(key, n); else this.watching.delete(key); };
  }
  approval(target: Target): Json | undefined {
    const pending = [...this.pending.entries()].find(([, p]) => JSON.stringify(p.target) === JSON.stringify(target));
    return pending ? { actionId: pending[0], toolName: pending[1].tool, title: `Allow ${pending[1].tool}?`, message: pending[1].message } : undefined;
  }
  async answer(target: Target, id: string, decision: unknown) {
    const entry = this.pending.get(id);
    if (!entry || JSON.stringify(entry.target) !== JSON.stringify(target) || !["approve", "deny"].includes(String(decision))) throw new BridgeError(409, "This approval is no longer pending.");
    await validateTarget(target);
    if (this.pending.get(id) !== entry || entry.response.destroyed) throw new BridgeError(409, "This approval is no longer pending.");
    this.pending.delete(id); clearTimeout(entry.timer);
    entry.response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {
      behavior: decision === "approve" ? "allow" : "deny", ...(decision === "deny" ? { message: "Declined in Phren." } : {}),
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
        if (body.event !== "PermissionRequest" || target.source === "copilot" || !this.watching.has(JSON.stringify(target))) { res.end("{}"); return; }
        // Only wait while a phone is watching this exact session; otherwise the
        // agent's ordinary terminal permission prompt remains immediate.
        if (this.pending.size >= 64) { res.end("{}"); return; }
        const action = randomUUID();
        const timer = setTimeout(() => { this.pending.delete(action); res.end("{}"); }, 55_000);
        this.pending.set(action, { target, response: res, tool: String(body.tool || "action").slice(0, 200),
          message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), timer });
        res.on("close", () => { clearTimeout(timer); this.pending.delete(action); });
      } catch { if (!res.headersSent) res.statusCode = 400; res.end("{}"); }
    });
    this.server.requestTimeout = 65_000;
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(localSocket(), () => resolve()); });
    await chmod(localSocket(), 0o600);
  }
  close() {
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
  const data = JSON.stringify({ target, event, tool: value.tool_name, input: value.tool_input });
  await new Promise<void>(resolve => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST", timeout: event === "PermissionRequest" ? 58_000 : 1500,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => {
      let result = "";
      res.on("data", chunk => { result += chunk.toString(); if (result.length > 16_384) req.destroy(); });
      res.on("end", () => { if (res.statusCode === 200 && event === "PermissionRequest") process.stdout.write(result); resolve(); });
      res.on("error", () => resolve());
    });
    req.on("error", () => resolve()); req.on("timeout", () => { req.destroy(); resolve(); }); req.end(data);
  });
}
