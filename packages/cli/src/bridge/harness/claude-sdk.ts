import { randomUUID } from "node:crypto";
import { answeredQuestionInput } from "../terminal-choice.js";
import { HarnessEvents, noCapabilities, sessionResult, newTurnId, type HarnessAdapter, type HarnessStart, type PaneBinding } from "./contract.js";

type SdkQuery = AsyncIterable<Record<string, any>> & { interrupt(): Promise<void>; setModel(model?: string): Promise<void>; close(): void };
interface Sdk { query(input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): SdkQuery; getSessionMessages?(session: string, options: { dir: string }): Promise<unknown> }
class InputStream implements AsyncIterable<unknown> {
  private rows: unknown[] = []; private wake?: () => void; private closed = false;
  push(message: unknown) { if (this.closed) throw new Error("Claude SDK session is closed."); this.rows.push(message); this.wake?.(); }
  close() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() { while (!this.closed) { const row = this.rows.shift(); if (row) yield row; else await new Promise<void>(resolve => { this.wake = resolve; }); } }
}
interface Pending { answer: (value: unknown) => void; input: Record<string, unknown>; tool: string }
interface Session { cwd: string; env: NodeJS.ProcessEnv; input: InputStream; query: SdkQuery; active?: string; stopped: boolean; pending: Map<string, Pending>; pump: Promise<void> }
/** Injected for regression source; normal loading uses an already-installed SDK, never npx/install. */
export async function installedClaudeSdk(): Promise<Sdk> {
  const module = process.env.PHREN_CLAUDE_SDK_MODULE ?? "@anthropic-ai/claude-agent-sdk";
  const sdk = await import(module);
  if (typeof sdk.query !== "function") throw new Error("The installed Claude Agent SDK has no query() API.");
  return sdk;
}
export class ClaudeSdkAdapter implements HarnessAdapter {
  readonly provider = "claude-sdk";
  readonly capabilities = { ...noCapabilities, startSession: true, interrupt: true, approvals: true, userInput: true, readThread: true, events: true, setModel: true, takeover: true };
  private sessions = new Map<string, Session>(); private events = new HarnessEvents();
  constructor(private sdk: Sdk, private executable: string, private settings: { permissionMode: "default" | "plan"; env?: Record<string, string | undefined>; pane?: PaneBinding }) {}
  private session(id: string) { const session = this.sessions.get(id); if (!session || session.stopped) throw new Error("Claude SDK session is not active."); return session; }
  async startSession(input: HarnessStart) {
    const id = input.resume ?? randomUUID(), messages = new InputStream(), pending = new Map<string, Pending>();
    if (this.sessions.has(id)) throw new Error("Claude SDK session is already owned by this adapter.");
    const env = { ...process.env, ...this.settings.env };
    // Subscription-only worker: do not silently select a billable API-key route.
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete env[key];
    const query = this.sdk.query({ prompt: messages, options: {
      cwd: input.cwd, pathToClaudeCodeExecutable: this.executable, env, permissionMode: this.settings.permissionMode,
      settingSources: ["user", "project", "local"], persistSession: true, includePartialMessages: true,
      ...(input.resume ? { resume: input.resume } : { sessionId: id }), ...(input.model ? { model: input.model } : {}),
      canUseTool: async (tool: string, params: Record<string, unknown>, options: { signal: AbortSignal }) => {
        const requestId = randomUUID();
        if (options.signal.aborted) return { behavior: "deny", message: "The tool request was cancelled." };
        return new Promise(resolve => {
          let settled = false;
          const answer = (response: unknown) => { if (settled) return; settled = true; pending.delete(requestId); options.signal.removeEventListener("abort", cancel); this.events.publish(id, "request-resolved", { requestId }); resolve(response); };
          const cancel = () => answer({ behavior: "deny", message: "The tool request was cancelled." });
          pending.set(requestId, { answer, input: params, tool }); options.signal.addEventListener("abort", cancel, { once: true });
          this.events.publish(id, tool === "AskUserQuestion" ? "user-input" : "approval", { requestId, tool, input: params });
          if (options.signal.aborted) cancel();
          // No timeout: the owner or conductor decides, or the harness cancels it.
        });
      },
    } });
    const session: Session = { cwd: input.cwd, env, input: messages, query, pending, stopped: false, pump: Promise.resolve() };
    this.sessions.set(id, session);
    session.pump = (async () => {
      try {
        for await (const event of query) {
          if (event.session_id && event.session_id !== id) { this.events.publish(id, "session-identity-mismatch"); await this.stop(id); break; }
          // Initialization and replay are observations, never completion of a newly queued turn.
          if (event.type === "result" && !session.active) continue;
          this.events.publish(id, event.type ?? "message", event, session.active);
          if (event.type === "result") session.active = undefined;
        }
      } catch { this.events.publish(id, "failed", { reason: "Claude SDK stream stopped." }, session.active); }
      finally { session.stopped = true; messages.close(); try { query.close(); } finally { for (const request of [...pending.values()]) request.answer({ behavior: "deny", message: "Claude SDK session ended." }); pending.clear(); this.events.end(id); } }
    })();
    return sessionResult(this, id, this.settings.pane);
  }
  async sendTurn(id: string, text: string) {
    const session = this.session(id); if (session.active) throw new Error("Claude SDK is still processing its previous turn.");
    const turnId = newTurnId(); session.active = turnId;
    session.input.push({ type: "user", session_id: id, uuid: turnId, parent_tool_use_id: null, message: { role: "user", content: text } });
    // The SDK queue has no server turn acknowledgement. Capabilities preserve that distinction.
    this.events.publish(id, "turn-queued", undefined, turnId); return { turnId, acknowledged: false };
  }
  async interruptTurn(id: string, turnId: string) { const session = this.session(id); if (session.active !== turnId) return false; for (const request of [...session.pending.values()]) request.answer({ behavior: "deny", message: "Turn interrupted." }); await session.query.interrupt(); return true; }
  async respondToRequest(id: string, requestId: string, response: unknown) {
    const session = this.session(id), request = session.pending.get(requestId); if (!request) return false;
    const value = response as { decision?: string; updatedInput?: Record<string, unknown> };
    if (value?.decision !== "approve" && value?.decision !== "deny") throw new Error("Send approve or deny.");
    if (value.updatedInput !== undefined && request.tool !== "AskUserQuestion") throw new Error("Only a question may replace its input through this approval surface.");
    const updatedInput = value.decision === "approve" && request.tool === "AskUserQuestion"
      ? answeredQuestionInput(request.tool, request.input, value.updatedInput) : request.input;
    // No updatedPermissions or remembered rule: one tool call only.
    request.answer(value.decision === "approve" ? { behavior: "allow", updatedInput } : { behavior: "deny", message: "Owner denied this tool call." }); return true;
  }
  respondToUserInput(id: string, requestId: string, response: unknown) {
    const request = this.session(id).pending.get(requestId);
    if (request && request.tool !== "AskUserQuestion") throw new Error("This pending request is not a user question.");
    return this.respondToRequest(id, requestId, response);
  }
  async readThread(id: string) { const session = this.sessions.get(id); if (!session) throw new Error("Unknown SDK session."); return this.sdk.getSessionMessages ? this.sdk.getSessionMessages(id, { dir: session.cwd }) : { events: this.events.read(id), partial: true }; }
  streamEvents(id: string, after?: number, signal?: AbortSignal) { if (!this.sessions.has(id)) throw new Error("Unknown SDK session."); return this.events.stream(id, after, signal); }
  async setModel(id: string, model: string) { await this.session(id).query.setModel(model); }
  private async stop(id: string) { const session = this.sessions.get(id); if (!session || session.stopped) return; session.stopped = true; session.input.close(); for (const request of [...session.pending.values()]) request.answer({ behavior: "deny", message: "SDK ownership ended." }); session.query.close(); }
  /** Private runner spawn policy: never serialized into an IPC or phone reply. */
  nativeResumeEnvironment(id: string): NodeJS.ProcessEnv {
    const session = this.sessions.get(id); if (!session) throw new Error("Unknown SDK session.");
    return { ...session.env };
  }
  async takeover(id: string, _pane: PaneBinding) { if (!this.sessions.has(id)) throw new Error("Unknown SDK session."); await this.stop(id); this.events.publish(id, "takeover", { command: "claude", session: id }); return { command: this.executable, args: ["--resume", id, "--permission-mode", this.settings.permissionMode] }; }
  async close() { for (const id of this.sessions.keys()) await this.stop(id); this.events.close(); }
}
