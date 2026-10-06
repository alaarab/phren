import type { AppServerClient, AppServerEvent, AppServerRequestId, PendingServerRequest } from "../codex-app-server.js";
import { CodexAppServerAdapter } from "./direct.js";
import { openAcpStdio } from "./acp-stdio.js";
import type { HarnessStart } from "./contract.js";

/** One installed Codex process owned by an explicit remote runner. No Hook, machine enrollment or daemon is needed. */
export class CodexStdioAdapter extends CodexAppServerAdapter {
  private initialize: Promise<unknown>;
  private stopTransport: () => void;
  constructor(executable: string, cwd: string) {
    const peer = openAcpStdio(executable, ["app-server"], cwd, process.env), pending = new Map<AppServerRequestId, PendingServerRequest>(), listeners = new Set<(event: AppServerEvent) => void>();
    const emit = (event: AppServerEvent) => { for (const listener of listeners) listener(event); };
    peer.on(event => {
      if (event.id === undefined) emit({ kind: "notification", method: event.method, params: event.params });
      else { const request = { requestId: event.id, method: event.method, params: event.params, ...(typeof event.params?.threadId === "string" ? { threadId: event.params.threadId } : {}) }; pending.set(event.id, request); emit({ kind: "request", ...request }); }
    });
    const client: AppServerClient = {
      pending, request: (method, params, timeout) => peer.request(method, params, timeout),
      threadStart: params => peer.request("thread/start", params), threadResume: params => peer.request("thread/resume", params),
      threadLoadedList: async () => (await peer.request("thread/loaded/list", {})).data,
      turnStart: async params => { const result = await peer.request("turn/start", params); if (typeof result?.turn?.id !== "string") throw new Error("Codex did not acknowledge a turn."); return { turnId: result.turn.id }; },
      turnSteer: async params => { const result = await peer.request("turn/steer", params); return { turnId: result.turnId }; },
      turnInterrupt: params => peer.request("turn/interrupt", params),
      interruptTurn: async (threadId, turnId) => { for (const request of pending.values()) if (request.threadId === threadId) client.respondError(request.requestId, -32000, "Owner interrupted this turn."); await peer.request("turn/interrupt", { threadId, turnId }); },
      respond: (id, result) => { const request = pending.get(id); peer.respond(id, result); pending.delete(id); emit({ kind: "resolved", requestId: id, threadId: request?.threadId }); },
      respondError: (id, code, message) => { const request = pending.get(id); peer.respondError(id, code, message); pending.delete(id); emit({ kind: "resolved", requestId: id, threadId: request?.threadId }); },
      on: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onClose: listener => peer.onClose!(listener), close: () => peer.close(),
    };
    super(client, { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" });
    this.initialize = peer.request("initialize", { clientInfo: { name: "phren-remote-agent", version: "1" }, capabilities: { experimentalApi: true } }).then(result => { peer.notify("initialized", {}); return result; });
    this.stopTransport = () => client.close();
  }
  async startSession(input: HarnessStart) { await this.initialize; return super.startSession(input); }
  async close() { try { await super.close(); } finally { this.stopTransport(); } }
}
