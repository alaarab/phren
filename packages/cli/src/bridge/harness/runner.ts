import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { z } from "zod";
import { atomicInPrivateDir, id, serverName, type Target } from "../protocol.js";
import { bindingPath } from "../agent-hook-stores.js";
import { terminalProvider } from "../terminal.js";
import { noteTurn } from "../turn-records.js";
import { recordBriefArrival } from "../launch-brief.js";
import { ClaudeSdkAdapter, installedClaudeSdk } from "./claude-sdk.js";
import { AcpAdapter } from "./acp.js";
import { openAcpStdio } from "./acp-stdio.js";
import { HarnessEvents, type HarnessAdapter } from "./contract.js";
import { runnerPaths, type RunnerEntry } from "./runner-client.js";

export const runnerConfigSchema = z.object({
  backend: z.string().regex(/^(claude-sdk|acp:[a-z][a-z0-9-]{0,31})$/), cwd: z.string().min(1).max(4096),
  model: z.string().min(1).max(200).optional(), resume: z.string().min(1).max(200).optional(),
  executable: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(100).default([]),
  permissionMode: z.enum(["default", "plan"]).default("default"),
  pane: z.object({ server: serverName, workspace: id, tab: id, pane: id }).optional(),
  briefFile: z.string().max(4096).optional(), briefId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(), once: z.boolean().default(false),
}).strict();
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

/** Runs in the worker's pane, outside the Hook's service lifetime. Never called by a build. */
export async function runHarnessWorker(raw: unknown): Promise<number> {
  const config = runnerConfigSchema.parse(raw), source = config.backend === "claude-sdk" ? "claude" : "phren";
  const adapter: HarnessAdapter = source === "claude"
    ? new ClaudeSdkAdapter(await installedClaudeSdk(), config.executable, { permissionMode: config.permissionMode })
    : new AcpAdapter(openAcpStdio(config.executable, config.args, config.cwd, process.env), config.backend.slice(4));
  let cleanup = async () => { await adapter.close(); };
  try {
  let closed = false, status = "idle", failure = false, entry: RunnerEntry | undefined;
  let ownsSocket = false, ownsEntry = false, submission: Promise<void> | undefined;
  const events = new HarnessEvents(), approvals = new Set<string>(), requests = new Map<string, Record<string, unknown>>(), controller = new AbortController();
  const session = await adapter.startSession({ cwd: config.cwd, ...(config.model ? { model: config.model } : {}), ...(config.resume ? { resume: config.resume } : {}) });
  // ACP ids are opaque. The Hook's alias is stable for this runner, with the native id explicit.
  const alias = source === "claude" ? z.string().uuid().parse(session.id) : randomUUID();
  let target: Target | undefined;
  if (config.pane) {
    const snapshot = await terminalProvider().snapshot(config.pane.server);
    const pane = (snapshot.panes as Array<Record<string, unknown>> | undefined)?.find(row => row.pane_id === config.pane!.pane && row.workspace_id === config.pane!.workspace && row.tab_id === config.pane!.tab);
    if (!pane || typeof pane.terminal_id !== "string") { await adapter.close(); throw new Error("The structured worker pane changed during startup."); }
    entry = { version: 1, pid: process.pid, ...config.pane, terminal: pane.terminal_id, source, session: alias, nativeSession: session.id, provider: adapter.provider, capabilities: session.capabilities };
    target = { ...config.pane, source, session: alias };
  }
  async function lifecycle(event: string, reply?: string) {
    if (!entry || !target) return;
    status = event === "PermissionRequest" ? "blocked" : event === "UserPromptSubmit" || event === "PreToolUse" ? "working" : "idle";
    await atomicInPrivateDir(bindingPath(entry.server, entry.pane), { terminal: entry.terminal, source, session: alias, pids: [process.pid], event, at: new Date().toISOString() });
    await noteTurn(entry.server, entry.pane, { terminal: entry.terminal, source, session: alias, event, cwd: config.cwd, ...(config.briefId ? { dispatch: config.briefId } : {}), ...(reply ? { reply } : {}) });
    await terminalProvider().reportAgent?.(entry.server, entry.pane, source, status as "idle" | "working" | "blocked").catch(() => {});
  }
  async function turn(text: string) {
    const prompt = z.string().min(1).max(32768).parse(text);
    if (submission) throw new Error("A turn submission is still in flight.");
    let release: () => void = () => {};
    submission = new Promise<void>(resolve => { release = resolve; });
    try {
      const result = await adapter.sendTurn(session.id, prompt);
      await lifecycle("UserPromptSubmit");
      if (result.acknowledged && config.briefId && target) await recordBriefArrival(config.briefId, "UserPromptSubmit", target);
      return result;
    } finally { release(); submission = undefined; }
  }
  const pump = async () => {
    for await (const row of adapter.streamEvents(session.id, 0, controller.signal)) {
      // A fast completion must never overtake its recorded prompt.
      if (submission) await submission;
      events.publish(alias, row.type, row.data, row.turnId);
      console.log(JSON.stringify({ ...row, session: alias, nativeSession: session.id, provider: adapter.provider }));
      const data = row.data as Record<string, any> | undefined;
      if ((row.type === "approval" || row.type === "user-input") && typeof data?.requestId === "string") { approvals.add(data.requestId); requests.set(data.requestId, { ...data, kind: row.type, ...(source !== "claude" ? { tool: "ACP permission", input: data } : {}) }); await lifecycle("PermissionRequest"); }
      else if (row.type === "request-resolved" && typeof data?.requestId === "string") { approvals.delete(data.requestId); requests.delete(data.requestId); if (!approvals.size) await lifecycle("PreToolUse"); }
      else if (row.type === "user" && config.briefId && target) await recordBriefArrival(config.briefId, "UserPromptSubmit", target);
      else if (row.type === "result" || row.type === "turn-ended") {
        failure = data?.is_error === true;
        if (config.briefId && target) await recordBriefArrival(config.briefId, "UserPromptSubmit", target);
        await lifecycle("Stop", typeof data?.result === "string" ? data.result : undefined);
        if (config.once) void finish();
      } else if (row.type === "failed" || row.type === "session-identity-mismatch") { failure = true; if (config.once) void finish(); }
    }
  };
  const service = createServer(async (request, response) => {
    try {
      if (closed || request.method !== "POST") throw new Error("Harness is closed.");
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 128 * 1024) throw new Error("Harness request exceeded its limit."); chunks.push(chunk); }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!entry || message.session !== alias || message.nativeSession !== session.id || message.pid !== process.pid) throw new Error("Harness ownership changed.");
      const input = message.input ?? {}; let result: unknown;
      switch (request.url) {
        case "/turn": result = await turn(input.text); break;
        case "/interrupt": result = { ok: await adapter.interruptTurn(session.id, z.string().min(1).max(200).parse(input.turnId)) }; break;
        case "/approval": result = { ok: await adapter.respondToRequest(session.id, z.string().min(1).max(200).parse(input.requestId), input.response) }; break;
        case "/input": result = { ok: await adapter.respondToUserInput(session.id, z.string().min(1).max(200).parse(input.requestId), input.response) }; break;
        case "/requests": result = { requests: [...requests.values()] }; break;
        case "/thread": result = await adapter.readThread(session.id); break;
        case "/events": { const after = z.number().int().nonnegative().parse(input.after ?? 0); const rows = events.read(alias), first = rows[0]?.seq; result = { events: [...(first && after < first - 1 ? [{ seq: first - 1, session: alias, type: "event-gap" }] : []), ...rows.filter(row => row.seq > after).slice(0, 100)], closed }; break; }
        case "/model": if (!adapter.setModel || !adapter.capabilities.setModel) throw new Error("Model selection is unavailable."); await adapter.setModel(session.id, z.string().min(1).max(200).parse(input.model)); result = { ok: true }; break;
        case "/takeover": if (!adapter.takeover) throw new Error("Takeover is unavailable."); result = await adapter.takeover(session.id, { server: entry.server, pane: entry.pane, terminal: entry.terminal }); break;
        default: throw new Error("Unknown harness operation.");
      }
      const body = JSON.stringify(result ?? {}); if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("Harness reply exceeded its limit.");
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(body);
      if (request.url === "/takeover") { const next = result as { command: string; args: string[] }; await finish(); const child = spawn(next.command, next.args, { cwd: config.cwd, env: process.env, stdio: "inherit" }); child.on("error", () => { process.exitCode = 1; }); }
    } catch { if (!response.headersSent) response.writeHead(409, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "Harness operation failed or ownership changed; do not automatically retry a submitted turn." })); }
  });
  const input = createInterface({ input: process.stdin, terminal: false });
  let resolveEnd: () => void = () => {}; const ended = new Promise<void>(resolve => { resolveEnd = resolve; });
  async function finish() {
    if (closed) return; closed = true; controller.abort(); input.close();
    try { await adapter.close(); }
    finally {
      events.close(); service.close();
      if (entry) {
        const files = runnerPaths(entry.server, entry.pane);
        if (ownsEntry) await unlink(files.entry).catch(() => {});
        if (ownsSocket) await unlink(files.socket).catch(() => {});
      }
      resolveEnd();
    }
  }
  cleanup = finish;
  if (entry) {
    const files = runnerPaths(entry.server, entry.pane); await mkdir(files.directory, { recursive: true, mode: 0o700 });
    // A still-listening previous owner is never unlinked or killed for a new launch.
    await new Promise<void>((resolve, reject) => { service.once("error", reject); service.listen(files.socket, () => { ownsSocket = true; resolve(); }); });
    await chmod(files.socket, 0o600); await atomicInPrivateDir(files.entry, entry); ownsEntry = true; await lifecycle("SessionStart");
    if (config.briefId && target) await recordBriefArrival(config.briefId, "SessionStart", target);
  }
  void pump().catch(() => { failure = true; void finish(); });
  const headlessInput: string[] = []; let headlessSize = 0;
  input.on("line", line => { if (config.once && !config.briefFile) { headlessSize += line.length + 1; if (headlessSize > 32768) { failure = true; void finish(); } else headlessInput.push(line); return; } void (async () => { const match = /^\/(approve|deny) (\S+)$/.exec(line); if (match) await adapter.respondToRequest(session.id, match[2], { decision: match[1] }); else if (line.trim()) await turn(line); })().catch(() => console.error("Harness input failed; inspect the current session before retrying.")); });
  input.on("close", () => { if (closed) return; if (config.once && !config.briefFile) void turn(headlessInput.join("\n")).catch(() => { failure = true; void finish(); }); else if (!config.once && !closed) void finish(); });
  if (config.briefFile) await turn(await readFile(config.briefFile, "utf8"));
  process.once("SIGTERM", () => { void finish(); }); process.once("SIGINT", () => { void finish(); });
  await ended;
  return failure ? 1 : 0;
  } finally { await cleanup(); }
}
