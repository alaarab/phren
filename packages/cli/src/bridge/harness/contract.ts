/** Shared Hook provider contract. Capabilities describe actual operations, not product names. */
import { randomUUID } from "node:crypto";
export interface HarnessCapabilities {
  startSession: boolean; turnAcknowledgement: boolean; interrupt: boolean; approvals: boolean;
  userInput: boolean; readThread: boolean; events: boolean; setModel: boolean; takeover: boolean;
}
export interface PaneBinding { server: string; pane: string; terminal?: string }
export interface HarnessSession { id: string; provider: string; pane?: PaneBinding; capabilities: HarnessCapabilities }
export interface HarnessEvent { seq: number; session: string; turnId?: string; type: string; data?: unknown }
export interface HarnessStart { cwd: string; resume?: string; model?: string }
export interface HarnessAdapter {
  readonly provider: string; readonly capabilities: HarnessCapabilities;
  startSession(input: HarnessStart): Promise<HarnessSession>;
  sendTurn(session: string, text: string): Promise<{ turnId: string; acknowledged: boolean }>;
  interruptTurn(session: string, turnId: string): Promise<boolean>;
  respondToRequest(session: string, requestId: string, response: unknown): Promise<boolean>;
  respondToUserInput(session: string, requestId: string, response: unknown): Promise<boolean>;
  readThread(session: string): Promise<unknown>;
  streamEvents(session: string, after?: number, signal?: AbortSignal): AsyncIterable<HarnessEvent>;
  setModel?(session: string, model: string): Promise<void>;
  takeover?(session: string, pane: PaneBinding): Promise<{ command: string; args: string[] }>;
  close(): Promise<void>;
}
export const noCapabilities: HarnessCapabilities = { startSession: false, turnAcknowledgement: false, interrupt: false, approvals: false, userInput: false, readThread: false, events: false, setModel: false, takeover: false };
export class UnsupportedHarnessOperation extends Error { constructor(operation: string) { super(`This harness does not support ${operation}.`); } }
/** Bounded event journal. A slow consumer sees an explicit gap; it never loses data silently. */
export class HarnessEvents {
  private sequence = 0;
  private rows: HarnessEvent[] = [];
  private bytes = 0;
  private wake = new Set<() => void>();
  private closed = false;
  publish(session: string, type: string, data?: unknown, turnId?: string) {
    if (this.closed) return;
    const row = { seq: ++this.sequence, session, type, ...(data === undefined ? {} : { data }), ...(turnId ? { turnId } : {}) };
    let size: number; try { size = Buffer.byteLength(JSON.stringify(row)); } catch { return; }
    if (size > 1024 * 1024) { row.type = "event-too-large"; delete row.data; size = 256; }
    this.rows.push(row); this.bytes += size;
    while (this.rows.length > 1000 || this.bytes > 8 * 1024 * 1024) this.bytes -= Buffer.byteLength(JSON.stringify(this.rows.shift()));
    for (const notify of this.wake) notify();
  }
  read(session: string) { return this.rows.filter(row => row.session === session); }
  async *stream(session: string, after = 0, signal?: AbortSignal): AsyncGenerator<HarnessEvent> {
    let cursor = after;
    while (!this.closed && !signal?.aborted) {
      const first = this.rows[0]?.seq;
      if (first && cursor < first - 1) { yield { seq: first - 1, session, type: "event-gap", data: { after: cursor } }; cursor = first - 1; }
      const rows = this.rows.filter(row => row.seq > cursor);
      for (const row of rows) { cursor = row.seq; if (row.session === session) yield row; }
      if (rows.length) continue;
      await new Promise<void>(resolve => {
        const done = () => { this.wake.delete(done); signal?.removeEventListener("abort", done); resolve(); };
        this.wake.add(done); signal?.addEventListener("abort", done, { once: true });
        if (this.closed || signal?.aborted || this.sequence > cursor) done();
      });
    }
  }
  close() { this.closed = true; for (const notify of this.wake) notify(); this.wake.clear(); }
}
export const newTurnId = () => randomUUID();
export function sessionResult(adapter: HarnessAdapter, id: string, pane?: PaneBinding): HarnessSession { return { id, provider: adapter.provider, capabilities: { ...adapter.capabilities }, ...(pane ? { pane } : {}) }; }
