import { serverQuestion } from "../questions.js";
import type { AppServerClient } from "../codex-app-server.js";
import type { PaneClient, PromptOptions } from "../opencode-pane-server.js";
import { terminalProvider } from "../terminal.js";
import { HarnessEvents, noCapabilities, sessionResult, UnsupportedHarnessOperation, newTurnId, type HarnessAdapter, type HarnessStart, type HarnessSession, type PaneBinding } from "./contract.js";

export class CodexAppServerAdapter implements HarnessAdapter {
  readonly provider = "codex-app-server";
  readonly capabilities = { ...noCapabilities, startSession: true, turnAcknowledgement: true, interrupt: true, approvals: true, userInput: true, readThread: true, events: true, setModel: true };
  private events = new HarnessEvents(); private sessions = new Set<string>(); private models = new Map<string, string>();
  private unsubscribe: () => void;
  /** Defaults are inherited from the launch policy; the adapter never adds broader permissions. */
  constructor(private client: AppServerClient, private defaults: Record<string, unknown>, private pane?: PaneBinding, existingSession?: string) {
    if (existingSession) this.sessions.add(existingSession);
    this.unsubscribe = client.on(event => {
      if (event.kind === "resolved") { if (event.threadId && this.sessions.has(event.threadId)) this.events.publish(event.threadId, "request-resolved", { requestId: String(event.requestId) }); return; }
      const params = event.params as Record<string, any>, session = (event.kind === "request" ? event.threadId : undefined) ?? params?.threadId ?? params?.thread?.id;
      if (typeof session === "string" && this.sessions.has(session)) this.events.publish(session, event.kind === "request" ? (serverQuestion(event) ? "user-input" : "approval") : event.method, event.kind === "request" ? { requestId: String(event.requestId), method: event.method, input: params } : params, params?.turnId ?? params?.turn?.id);
    });
  }
  private require(session: string) { if (!this.sessions.has(session)) throw new Error("Session does not belong to this adapter."); }
  async startSession(input: HarnessStart) {
    const result = input.resume ? await this.client.threadResume({ ...this.defaults, threadId: input.resume, cwd: input.cwd }) : await this.client.threadStart({ ...this.defaults, cwd: input.cwd, ...(input.model ? { model: input.model } : {}) });
    const id = (result.thread as Record<string, unknown>)?.id;
    if (typeof id !== "string") throw new Error("Codex did not acknowledge a thread.");
    this.sessions.add(id); return sessionResult(this, id, this.pane);
  }
  async sendTurn(session: string, text: string) { this.require(session); const result = await this.client.turnStart({ threadId: session, input: [{ type: "text", text, text_elements: [] }], ...(this.models.has(session) ? { model: this.models.get(session) } : {}) }); return { ...result, acknowledged: true }; }
  async interruptTurn(session: string, turnId: string) { this.require(session);
    const result = await this.client.request("thread/read", { threadId: session, includeTurns: true }) as { thread?: { turns?: Array<{ id?: string; status?: string }> } };
    if (!result.thread?.turns?.some(turn => turn.id === turnId && turn.status === "inProgress")) return false;
    await this.client.interruptTurn(session, turnId); return true;
  }
  async respondToRequest(session: string, requestId: string, response: unknown) { this.require(session); const pending = [...this.client.pending.values()].find(r => String(r.requestId) === requestId && r.threadId === session); if (!pending) return false;
    const decision = (response as { decision?: string })?.decision;
    if (decision !== "approve" && decision !== "deny") throw new Error("Send approve or deny.");
    if (pending.method === "item/permissions/requestApproval" && decision === "approve") throw new Error("Permission expansion belongs to the existing owner approval workflow.");
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(pending.method)) throw new UnsupportedHarnessOperation("this approval method");
    this.client.respond(pending.requestId, pending.method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } : { decision: decision === "approve" ? "accept" : "decline" }); return true; }
  async respondToUserInput(session: string, requestId: string, response: unknown) { this.require(session);
    const pending = [...this.client.pending.values()].find(r => String(r.requestId) === requestId && r.threadId === session), shown = pending && serverQuestion(pending);
    if (!pending || !shown) return false;
    const values = (response as { answers?: unknown })?.answers;
    if (!Array.isArray(values) || values.length !== shown.questions.length || values.some(value => typeof value !== "string")) throw new Error("Send one text answer for each question.");
    this.client.respond(pending.requestId, shown.result(values)); return true;
  }
  async readThread(session: string) { this.require(session); return this.client.request("thread/read", { threadId: session, includeTurns: true }); }
  streamEvents(session: string, after?: number, signal?: AbortSignal) { this.require(session); return this.events.stream(session, after, signal); }
  async setModel(session: string, model: string) { this.require(session); this.models.set(session, model); }
  async close() { this.unsubscribe(); this.events.close(); } // Client remains owned by CodexServers.
}

export class OpenCodeServeAdapter implements HarnessAdapter {
  readonly provider = "opencode-serve";
  readonly capabilities = { ...noCapabilities, startSession: true, turnAcknowledgement: true, interrupt: true, approvals: true, userInput: true, readThread: true, events: true, setModel: true };
  private sessions = new Set<string>(); private settings = new Map<string, PromptOptions>();
  private active = new Map<string, string>();
  private journal = new HarnessEvents(); private abort = new AbortController(); private watching = false;
  constructor(private client: PaneClient, private pane?: PaneBinding, existingSession?: string) { if (existingSession) this.sessions.add(existingSession); }
  private require(session: string) { if (!this.sessions.has(session)) throw new Error("Session does not belong to this adapter."); }
  async startSession(input: HarnessStart) { const result = input.resume ? await this.client.session(input.resume) : await this.client.createSession(); if (!result || result.parentID || result.directory && result.directory !== input.cwd) throw new Error("OpenCode session is unavailable or belongs to a different directory."); this.sessions.add(result.id); await this.client.selectSession(result.id); if (input.model) this.settings.set(result.id, { model: input.model }); return sessionResult(this, result.id, this.pane); }
  async sendTurn(session: string, text: string) { this.require(session); const result = await this.client.prompt(session, text, { inherit: true, ...this.settings.get(session) }); if (!result.delivered) throw new Error("OpenCode sent the prompt but its user-message acknowledgement is uncertain. Do not retry automatically."); this.active.set(session, result.messageId); return { turnId: result.messageId, acknowledged: true }; }
  async interruptTurn(session: string, turnId: string) { this.require(session);
    if (this.active.get(session) !== turnId || !this.client.messages) return false;
    const latest = (await this.client.messages(session)).filter(row => row.info?.role === "user").at(-1)?.info?.id;
    if (latest !== turnId) return false;
    const interrupted = await this.client.abort(session); if (interrupted) this.active.delete(session); return interrupted;
  }
  async respondToRequest(session: string, requestId: string, response: unknown) { this.require(session); const found = (await this.client.permissions()).find(p => p.id === requestId && p.sessionID === session); if (!found) return false; const reply = (response as { decision?: string })?.decision; if (reply !== "approve" && reply !== "deny") throw new Error("Send approve or deny; this operation never creates standing permissions."); await this.client.replyPermission(requestId, reply === "approve" ? "once" : "reject"); return true; }
  async respondToUserInput(session: string, requestId: string, response: unknown) { this.require(session); const found = (await this.client.questions()).find(q => q.id === requestId && q.sessionID === session); if (!found) return false; const answers = (response as { answers?: unknown })?.answers; if (!Array.isArray(answers) || answers.some(a => !Array.isArray(a) || a.some(t => typeof t !== "string"))) throw new Error("Send arrays of selected answer labels."); await this.client.replyQuestion(requestId, answers); return true; }
  async readThread(session: string) { this.require(session); if (!this.client.messages) throw new UnsupportedHarnessOperation("thread reads"); return { messages: await this.client.messages(session), partial: true, reason: "Recent message window from the served pane." }; }
  streamEvents(session: string, after = 0, signal?: AbortSignal) { this.require(session);
    if (!this.watching) { this.watching = true; void (async () => {
      try { for await (const event of this.client.events(this.abort.signal)) { const data = event.properties as Record<string, any>, id = data?.sessionID ?? data?.info?.sessionID; if (this.sessions.has(id)) this.journal.publish(id, event.type, data); } }
      catch { for (const id of this.sessions) this.journal.publish(id, "event-gap", { reason: "OpenCode event connection stopped." }); }
      finally { this.journal.close(); }
    })(); }
    return this.journal.stream(session, after, signal);
  }
  async setModel(session: string, model: string) { this.require(session); this.settings.set(session, { model }); }
  async close() { this.abort.abort(); this.journal.close(); }
}

/** Fallback identifies submission separately from a harness-acknowledged turn. */
export class PaneTypingAdapter implements HarnessAdapter {
  readonly provider = "pane-typing"; readonly capabilities = { ...noCapabilities };
  constructor(private pane: PaneBinding, private session: string) {}
  async startSession(_input: HarnessStart): Promise<HarnessSession> { throw new UnsupportedHarnessOperation("session creation through pane typing"); }
  async sendTurn(session: string, text: string) { if (session !== this.session) throw new Error("The pane session changed."); await terminalProvider().prompt(this.pane.server, this.pane.pane, text); return { turnId: `submission:${newTurnId()}`, acknowledged: false }; }
  async interruptTurn(_session: string, _turnId: string): Promise<boolean> { throw new UnsupportedHarnessOperation("turn-scoped interrupt"); }
  async respondToRequest(): Promise<boolean> { throw new UnsupportedHarnessOperation("structured approval"); }
  async respondToUserInput(): Promise<boolean> { throw new UnsupportedHarnessOperation("structured input"); }
  async readThread(): Promise<unknown> { throw new UnsupportedHarnessOperation("thread read"); }
  async *streamEvents(): AsyncGenerator<never> { throw new UnsupportedHarnessOperation("structured events"); }
  async close() {}
}
