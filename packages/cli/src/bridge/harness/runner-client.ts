import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { z } from "zod";
import { bridgeRoot, sessionId, type Target, type Provider } from "../protocol.js";
import { terminalProvider } from "../terminal.js";
import type { HarnessAdapter, HarnessCapabilities, HarnessStart, PaneBinding } from "./contract.js";
import { UnsupportedHarnessOperation } from "./contract.js";

const capabilities = z.object({ startSession: z.boolean(), turnAcknowledgement: z.boolean(), interrupt: z.boolean(), approvals: z.boolean(), userInput: z.boolean(), readThread: z.boolean(), events: z.boolean(), setModel: z.boolean(), takeover: z.boolean() });
export const runnerEntrySchema = z.object({ version: z.literal(1), pid: z.number().int().positive(), server: z.string(), pane: z.string(), terminal: z.string(), source: z.enum(["claude", "phren"]), session: sessionId, nativeSession: z.string().min(1).max(200), provider: z.string().min(1).max(100), capabilities });
export type RunnerEntry = z.infer<typeof runnerEntrySchema>;
export function runnerPaths(server: string, pane: string) {
  const key = createHash("sha256").update(server + "\0" + pane).digest("hex").slice(0, 24), directory = path.join(bridgeRoot(), "harness");
  return { directory, entry: path.join(directory, key + ".json"), socket: path.join(directory, key + ".sock") };
}
/** A private registry is trusted only while its process is in the current pane. */
export async function runnerForPane(server: string, pane: { pane_id?: unknown; terminal_id?: unknown; agent?: unknown }, pids?: number[]): Promise<RunnerEntry | undefined> {
  try {
    const file = runnerPaths(server, String(pane.pane_id)).entry, info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || (info.mode & 0o077)) return undefined;
    const entry = runnerEntrySchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (entry.server !== server || entry.pane !== pane.pane_id || entry.terminal !== pane.terminal_id || entry.source !== pane.agent) return undefined;
    pids ??= (await terminalProvider().processes(server, entry.pane)).foregroundPids;
    return pids.includes(entry.pid) ? entry : undefined;
  } catch { return undefined; }
}
export function runnerRequest(entry: RunnerEntry, operation: string, input: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: runnerPaths(entry.server, entry.pane).socket, path: "/" + operation, method: "POST", headers: { "Content-Type": "application/json" } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) req.destroy(new Error("Harness reply exceeded its limit.")); else chunks.push(chunk); });
      res.on("error", reject); res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (res.statusCode !== 200) reject(new Error(value.error ?? "Harness request failed.")); else resolve(value); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.setTimeout(10000, () => req.destroy(new Error("Harness reply timed out; do not retry a turn automatically.")));
    req.end(JSON.stringify({ session: entry.session, nativeSession: entry.nativeSession, pid: entry.pid, input }));
  });
}
/** IPC is an observation of the pane's worker; closing it never ends the worker. */
export class RunnerAdapter implements HarnessAdapter {
  readonly provider: string; readonly capabilities: HarnessCapabilities;
  constructor(readonly entry: RunnerEntry) { this.provider = entry.provider; this.capabilities = { ...entry.capabilities, startSession: false }; }
  private require(session: string) { if (session !== this.entry.session) throw new Error("The harness session changed."); }
  async startSession(_input: HarnessStart): Promise<never> { throw new UnsupportedHarnessOperation("session creation on an existing pane"); }
  async sendTurn(session: string, text: string) { this.require(session); return runnerRequest(this.entry, "turn", { text }); }
  async interruptTurn(session: string, turnId: string) { this.require(session); return (await runnerRequest(this.entry, "interrupt", { turnId })).ok; }
  async respondToRequest(session: string, requestId: string, response: unknown) { this.require(session); return (await runnerRequest(this.entry, "approval", { requestId, response })).ok; }
  async respondToUserInput(session: string, requestId: string, response: unknown) { this.require(session); return (await runnerRequest(this.entry, "input", { requestId, response })).ok; }
  async readThread(session: string) { this.require(session); return runnerRequest(this.entry, "thread"); }
  async *streamEvents(session: string, after = 0, signal?: AbortSignal) { this.require(session); let cursor = after;
    while (!signal?.aborted) { const reply = await runnerRequest(this.entry, "events", { after: cursor }); for (const row of reply.events) { cursor = Math.max(cursor, row.seq); yield { ...row, session }; } if (reply.closed) return;
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, 500); signal?.addEventListener("abort", done, { once: true }); if (signal?.aborted) done(); });
    }
  }
  async setModel(session: string, model: string) { this.require(session); await runnerRequest(this.entry, "model", { model }); }
  async takeover(session: string, pane: PaneBinding) { this.require(session); if (pane.server !== this.entry.server || pane.pane !== this.entry.pane || pane.terminal !== this.entry.terminal) throw new Error("Takeover pane changed."); return runnerRequest(this.entry, "takeover", { pane }); }
  async close() {}
}
