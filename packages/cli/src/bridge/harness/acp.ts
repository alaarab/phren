import { HarnessEvents, noCapabilities, sessionResult, newTurnId, UnsupportedHarnessOperation, type HarnessAdapter, type HarnessStart, type PaneBinding } from "./contract.js";
export interface AcpPeer {
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params: unknown): void;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, code: number, message: string): void;
  on(listener: (event: { method: string; params: any; id?: string | number }) => void): () => void;
  onClose?(listener: () => void): () => void;
  close(): void;
}
/** ACP v1 transport. Harness brands are configured executables, not assumed protocol support. */
export class AcpAdapter implements HarnessAdapter {
  readonly provider: string;
  readonly capabilities = { ...noCapabilities, startSession: true, interrupt: true, approvals: true, events: true, readThread: true };
  private events = new HarnessEvents(); private initialized?: Promise<any>; private initialization: any;
  private sessions = new Map<string, { active?: string; loaded: boolean; modelSupport: boolean }>();
  private pending = new Map<string, { rpcId: string | number; session: string; params: any }>();
  private unsubscribe: () => void;
  private unsubscribeClose?: () => void;
  constructor(private peer: AcpPeer, brand: string, private pane?: PaneBinding) {
    this.provider = `acp:${brand}`;
    this.unsubscribe = peer.on(event => {
      const session = event.params?.sessionId;
      if (typeof session !== "string" || !this.sessions.has(session)) { if (event.id !== undefined) peer.respondError(event.id, -32602, "Unknown session."); return; }
      if (event.id !== undefined) {
        if (event.method !== "session/request_permission") { peer.respondError(event.id, -32601, "Client filesystem, terminal and custom methods are unavailable."); return; }
        const requestId = `${typeof event.id}:${event.id}`;
        if (this.pending.has(requestId)) { peer.respondError(event.id, -32600, "Duplicate permission request."); return; }
        this.pending.set(requestId, { rpcId: event.id, session, params: event.params });
        this.events.publish(session, "approval", { requestId, ...event.params }, this.sessions.get(session)?.active);
      } else if (event.method === "session/update") this.events.publish(session, event.params?.update?.sessionUpdate ?? "update", event.params.update, this.sessions.get(session)?.active);
    });
    this.unsubscribeClose = peer.onClose?.(() => {
      for (const [id, session] of this.sessions) this.events.publish(id, "failed", { reason: "ACP transport closed; do not retry automatically." }, session.active);
      this.pending.clear(); this.events.close();
    });
  }
  private ready() { return this.initialized ??= this.peer.request("initialize", { protocolVersion: 1, clientInfo: { name: "phren-hook", version: "1" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }).then(result => { if (result.protocolVersion !== 1) throw new Error("ACP protocol version mismatch."); this.initialization = result; return result; }); }
  private session(id: string) { const session = this.sessions.get(id); if (!session) throw new Error("Session does not belong to this ACP adapter."); return session; }
  async startSession(input: HarnessStart) {
    const initialized = await this.ready();
    if (input.resume && !initialized.agentCapabilities?.loadSession) throw new UnsupportedHarnessOperation("ACP session loading");
    if (input.resume && this.sessions.has(input.resume)) throw new Error("ACP session is already owned by this adapter.");
    if (input.resume) this.sessions.set(input.resume, { loaded: true, modelSupport: false }); // Receive replay while load is in flight.
    let result: any;
    try { result = await this.peer.request(input.resume ? "session/load" : "session/new", { cwd: input.cwd, mcpServers: [], ...(input.resume ? { sessionId: input.resume } : {}) }); }
    catch (error) { if (input.resume) this.sessions.delete(input.resume); throw error; }
    const id = input.resume ?? result.sessionId; if (typeof id !== "string" || !id || id.length > 200 || result.sessionId && result.sessionId !== id) throw new Error("ACP did not acknowledge the requested session.");
    const modelSupport = !!result.models;
    this.capabilities.setModel = modelSupport;
    this.sessions.set(id, { loaded: true, modelSupport });
    if (input.model) { if (!modelSupport) throw new UnsupportedHarnessOperation("ACP model selection"); await this.setModel(id, input.model); }
    return { ...sessionResult(this, id, this.pane), capabilities: { ...this.capabilities, setModel: modelSupport } };
  }
  async sendTurn(id: string, text: string) {
    const session = this.session(id); if (session.active) throw new Error("ACP is still processing its previous turn.");
    const turnId = newTurnId(); session.active = turnId;
    this.events.publish(id, "user-message", { text }, turnId);
    this.events.publish(id, "turn-queued", undefined, turnId);
    // session/prompt returns at completion, not start. It has no native turn id.
    void this.peer.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] }, 0).then(result => {
      if (session.active === turnId) session.active = undefined;
      this.events.publish(id, "turn-ended", result, turnId);
    }, () => { if (session.active === turnId) session.active = undefined; this.events.publish(id, "failed", { reason: "ACP prompt failed; do not retry automatically." }, turnId); });
    return { turnId, acknowledged: false };
  }
  async interruptTurn(id: string, turnId: string) { const session = this.session(id); if (session.active !== turnId) return false; for (const [key, request] of this.pending) if (request.session === id) { this.peer.respond(request.rpcId, { outcome: { outcome: "cancelled" } }); this.pending.delete(key); this.events.publish(id, "request-resolved", { requestId: key }); } this.peer.notify("session/cancel", { sessionId: id }); return true; }
  async respondToRequest(id: string, requestId: string, response: unknown) {
    this.session(id); const request = this.pending.get(requestId); if (!request || request.session !== id) return false;
    const decision = (response as { decision?: string })?.decision;
    if (decision !== "approve" && decision !== "deny") throw new Error("Send approve or deny.");
    const option = (request.params.options ?? []).find((o: any) => o.kind === (decision === "approve" ? "allow_once" : "reject_once"));
    if (decision === "approve" && !option) throw new Error("This ACP request has no one-time approval; persistent permissions are not granted here.");
    this.peer.respond(request.rpcId, option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } }); this.pending.delete(requestId); this.events.publish(id, "request-resolved", { requestId }); return true;
  }
  async respondToUserInput(): Promise<boolean> { throw new UnsupportedHarnessOperation("ACP structured user questions"); }
  async readThread(id: string) { this.session(id); return { events: this.events.read(id), partial: true, reason: "ACP v1 has no arbitrary thread-read method; this is the observed event window." }; }
  streamEvents(id: string, after?: number, signal?: AbortSignal) { this.session(id); return this.events.stream(id, after, signal); }
  async setModel(id: string, model: string) { if (!this.session(id).modelSupport) throw new UnsupportedHarnessOperation("ACP model selection"); await this.peer.request("session/set_model", { sessionId: id, modelId: model }); }
  async close() { try { for (const [id, session] of this.sessions) if (session.active) await this.interruptTurn(id, session.active); } finally { this.unsubscribe(); this.unsubscribeClose?.(); this.peer.close(); this.events.close(); } }
}
